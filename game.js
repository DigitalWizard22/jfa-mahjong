import { firebaseConfig } from "./firebase-config.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import { getAuth, signInAnonymously, onAuthStateChanged }
  from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import { getFirestore, doc, getDoc, setDoc, updateDoc, onSnapshot }
  from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const dbf = getFirestore(app);

let tableId = new URLSearchParams(location.search).get('table') || null;
let tableRef = tableId ? doc(dbf, 'tables', tableId) : null;
let unsubscribeListener = null;

const $ = id => document.getElementById(id);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ------------------------------------------------------------- tile rules
const glyph = i => String.fromCodePoint(i<9?0x1F007+i:i<18?0x1F010+i-9:i<27?0x1F019+i-18:i<34?0x1F000+i-27:0x1F022+i-34);
const SUITS = ['Characters','Sticks','Balls'];
const HONORS = ['East Wind','South Wind','West Wind','North Wind','Red Dragon','Green Dragon','White Dragon'];
const BONUS = ['Plum','Orchid','Bamboo','Chrysanthemum','Spring','Summer','Autumn','Winter'];
function tileName(i){ if(i<27){const suit=SUITS[Math.floor(i/9)],rank=(i%9)+1;return `${rank} ${suit}`} if(i<34) return HONORS[i-27]; return BONUS[i-34]; }
function tileOverview(i){ if(i<27){const suit=SUITS[Math.floor(i/9)],rank=(i%9)+1;return `${tileName(i)} — rank ${rank} of the ${suit} suit`} if(i<34) return `${tileName(i)} — Honor tile`; return `${tileName(i)} — Bonus tile (flower/season), scores on its own`; }
const tile = (i,cls='',idx=-1) => `<span class="t ${cls}" ${idx>=0?`data-idx="${idx}"`:''}>${glyph(i)}</span>`;
const back = () => `<span class="t s back">.</span>`;
function shuffle(a){for(let i=a.length-1;i>0;i--){const j=Math.random()*(i+1)|0;[a[i],a[j]]=[a[j],a[i]]}return a}
function sortHand(h){return h.slice().sort((a,b)=>a-b)}
function done(c,s){const i=c.findIndex(x=>x>0);if(i<0)return s==0;if(s==0)return false;
  if(c[i]>=3){c[i]-=3;const r=done(c,s-1);c[i]+=3;if(r)return true}
  if(i<27&&i%9<7&&c[i+1]&&c[i+2]){c[i]--;c[i+1]--;c[i+2]--;const r=done(c,s-1);c[i]++;c[i+1]++;c[i+2]++;if(r)return true}
  return false}
function canWin(h,sets){const c=Array(34).fill(0);h.forEach(t=>c[t]++);for(let p=0;p<34;p++)if(c[p]>=2){c[p]-=2;const r=done(c,sets);c[p]+=2;if(r)return true}return false}
function chowOptions(h,t){if(t>=27)return[];const r=t%9,o=[];const has=x=>h.includes(x);
  if(r>=2&&has(t-2)&&has(t-1))o.push([t-2,t-1]);
  if(r>=1&&r<=7&&has(t-1)&&has(t+1))o.push([t-1,t+1]);
  if(r<=6&&has(t+1)&&has(t+2))o.push([t+1,t+2]);
  return o}
function removeTiles(h,ts){ts.forEach(t=>h.splice(h.indexOf(t),1))}
function need(state,seat){return 5-state.melds[seat].length}

// ---------------------------------------------------- Firestore shape helpers
// Firestore rejects a field whose value is an array of arrays ("nested
// arrays are not supported"). hands/flowers are seat-indexed arrays of
// tile arrays, and melds is a seat-indexed array of arrays of tile arrays
// — both shapes Firestore refuses outright. We keep plain arrays
// everywhere in the game logic below, and only convert at the two edges:
// right after reading a document, and right before writing one.
function seatArrOut(arr){ const o={}; arr.forEach((v,i)=>{o[i]=v}); return o; }
function seatArrIn(obj){ return [0,1,2,3].map(i => (obj && obj[i]) ? obj[i] : []); }
function meldsOut(arr){ const o={}; arr.forEach((playerMelds,i)=>{ o[i]=playerMelds.map(m=>({tiles:m})); }); return o; }
function meldsIn(obj){ return [0,1,2,3].map(i => (obj && obj[i]) ? obj[i].map(m=>m.tiles) : []); }
function normalizeState(d){
  if(!d) return d;
  return {...d, hands: seatArrIn(d.hands), flowers: seatArrIn(d.flowers), melds: meldsIn(d.melds)};
}

function dealGame(){
  const all=[];for(let i=0;i<34;i++)for(let k=0;k<4;k++)all.push(i);for(let i=34;i<42;i++)all.push(i);
  shuffle(all);
  const walls=[0,1,2,3].map(i=>all.slice(i*36,i*36+36));
  const dealer=Math.floor(Math.random()*4);
  const choices=[0,1,2,3].filter(i=>i!==dealer);
  const chosen=choices[Math.random()*3|0];
  const hands=[[],[],[],[]];
  for(let j=0;j<4;j++){const recipient=(dealer+j)%4;
    for(let i=0;i<4;i++){const chunk=walls[i].splice(0,4);hands[recipient].push(...chunk)}}
  let wall=[].concat(...[0,1,2,3].map(k=>walls[(chosen+k)%4]));
  const flowers=[[],[],[],[]];
  for(let k=0;k<4;k++){const p=(dealer+k)%4;
    while(hands[p].some(t=>t>=34)){const idx=hands[p].findIndex(t=>t>=34);flowers[p].push(hands[p].splice(idx,1)[0]);hands[p].push(wall.pop())}}
  hands.forEach(h=>h.sort((a,b)=>a-b));
  return {hands,flowers,wall,dealer};
}

// ---------------------------------------------------------------- app state
let myId=null, myName=null;
let state=null;
let mySeat=-1;
let myOrder=[];
let lastSortSeq=-1;
let selectedIdx=-1;
const log = m => $('log').textContent = m;

onAuthStateChanged(auth, u => { if(u){ myId=u.uid; boot(); } });
signInAnonymously(auth).catch(() => log('Could not connect — check your Firebase config.'));

function boot(){
  myName = localStorage.getItem('mahjongName');
  if(!myName){
    $('screenName').style.display='block';
    $('screenTable').style.display='none';$('screenLobby').style.display='none';
    $('screenGame').style.display='none';$('nameBtn').onclick = () => {
      const v = $('nameInput').value.trim();
      if(!v) return;
      localStorage.setItem('mahjongName', v);
      myName = v;
      $('screenName').style.display='none';
      checkTableSelection();
    };
    return;
  }
  checkTableSelection();
}

function checkTableSelection(){
  if(!tableId){
    $('screenTable').style.display='block';
    $('screenLobby').style.display='none';$('screenGame').style.display='none';
    log('Create or join a table room to begin.');
  } else {
    $('screenTable').style.display='none';
    startListening();
  }
}

// Table Selector Event Listeners
$('joinTableBtn').onclick = () => {
  const input = $('tableInput').value.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
  if(!input){ log('Table name needs at least one letter or number.'); return; }
  selectTable(input);
};

$('randomTableBtn').onclick = () => {
  const rand = 'table-' + Math.random().toString(36).substring(2, 7);
  selectTable(rand);
};

$('switchTableBtn').onclick = () => {
  if(unsubscribeListener) unsubscribeListener();
  tableId = null; tableRef = null;
  resetLocalGameState();
  window.history.pushState({}, '', window.location.pathname);
  checkTableSelection();
};

function resetLocalGameState(){
  // Clears everything carried over from whichever table we were just on,
  // so switching tables (or loading straight into a mid-game table) can't
  // briefly render stale tiles, seats, or selection state from before.
  state=null; mySeat=-1; myOrder=[]; selectedIdx=-1; lastSortSeq=-1;
}

function selectTable(id){
  if(unsubscribeListener) unsubscribeListener();
  resetLocalGameState();
  tableId = id;
  tableRef = doc(dbf, 'tables', tableId);
  const newUrl = `${window.location.pathname}?table=${encodeURIComponent(id)}`;
  window.history.pushState({ path: newUrl }, '', newUrl);
  $('screenTable').style.display='none';
  startListening();
}

function startListening(){
  if(unsubscribeListener) unsubscribeListener();
  $('currentRoomTag').textContent = tableId;
  unsubscribeListener = onSnapshot(tableRef, snap => onSnap(snap), e => log('Connection issue: '+e.code));
  $('startBtn').onclick = startGame;
  $('leaveBtn').onclick = leaveSeat;
  $('newHandBtn').onclick = newHand;
  $('winClose').onclick = () => { $('winOverlay').classList.remove('show'); setTimeout(()=>$('winOverlay').classList.add('hidden'),300); };
}

function freshLobby(seats){
  return {phase:'lobby',seats,dealer:0,turn:0,turnPhase:'draw',turnSeq:0,
    hands:seatArrOut([[],[],[],[]]),melds:meldsOut([[],[],[],[]]),flowers:seatArrOut([[],[],[],[]]),
    discards:[],wall:[],drawn:null,pending:null,winner:null,log:'Waiting for a full table...'};
}

function onSnap(snap){
  state = snap.exists() ? normalizeState(snap.data()) : null;
  if(!state){
    $('screenLobby').style.display='block';$('screenGame').style.display='none';
    mySeat=-1; renderLobby([null,null,null,null]);
    log('No active players here — take a seat to claim this table.');
    return;
  }
  mySeat = state.seats.findIndex(s => s && s.uid===myId);
  if(state.phase==='lobby'){
    $('screenLobby').style.display='block';$('screenGame').style.display='none';
    renderLobby(state.seats);
    log(state.log||'');
    return;
  }
  $('screenLobby').style.display='none';$('screenGame').style.display='block';
  if(mySeat>=0){
    if(state.turn===mySeat && state.turnPhase==='discard' && state.turnSeq!==lastSortSeq){
      myOrder = sortHand(state.hands[mySeat]); lastSortSeq = state.turnSeq;
    } else {
      reconcileOrder(state.hands[mySeat]||[]);
    }
  }
  renderGame();
  if(state.phase==='ended') celebrate(state.winner);
}

function reconcileOrder(hand){
  const remaining = hand.slice();
  const kept = myOrder.filter(t => { const i=remaining.indexOf(t); if(i>=0){remaining.splice(i,1); return true} return false });
  myOrder = kept.concat(remaining);
}

// ------------------------------------------------------------------ lobby
function renderLobby(seats){
  const userSeated = seats.some(s => s && s.uid === myId);

  $('lobbyGrid').innerHTML = seats.map((s, i) => {
    if(!s){
      // Open seat: a real clickable button, yellow, unless you're already
      // sitting somewhere else at this table (then it's just greyed out).
      const btn = userSeated
        ? `<button disabled style="background:#555;color:#ccc">Open</button>`
        : `<button data-i="${i}" style="background:var(--acc);color:#2a1d00">Sit here</button>`;
      return `<div class="seatcard open"><div style="margin-bottom:8px"><b>Seat ${i+1}</b></div>${btn}</div>`;
    }
    // Occupied seat: same button, now grey and disabled, naming who's there.
    const isMe = s.uid === myId;
    return `<div class="seatcard ${isMe ? 'me' : 'taken'}">
      <div style="margin-bottom:8px"><b>Seat ${i+1}</b></div>
      <button disabled style="background:#555;color:${isMe ? 'var(--acc)' : '#ccc'}">${escapeHtml(s.name)} is seated${isMe ? ' (you)' : ''}</button>
    </div>`;
  }).join('');

  document.querySelectorAll('#lobbyGrid button[data-i]').forEach(b => b.onclick = () => joinSeat(+b.dataset.i));
  $('leaveBtn').style.display = userSeated ? 'inline-block' : 'none';
  $('startBtn').disabled = seats.some(s => !s);
}

function escapeHtml(s){ const d=document.createElement('div'); d.textContent=s; return d.innerHTML; }

async function joinSeat(i){
  const snap = await getDoc(tableRef);
  if(!snap.exists()){ const seats=[null,null,null,null]; seats[i]={uid:myId,name:myName}; await setDoc(tableRef, freshLobby(seats)); return; }
  const d = snap.data();
  if(d.phase!=='lobby' || d.seats.some(s=>s&&s.uid===myId) || d.seats[i]) return;
  const seats = d.seats.slice(); seats[i]={uid:myId,name:myName};
  await updateDoc(tableRef, {seats});
}

async function leaveSeat(){
  const snap = await getDoc(tableRef); if(!snap.exists()) return; const d = snap.data();
  if(d.phase!=='lobby') return;
  const seats = d.seats.map(s => (s&&s.uid===myId) ? null : s);
  await updateDoc(tableRef, {seats});
}

async function startGame(){
  const snap = await getDoc(tableRef); if(!snap.exists()) return; const d = snap.data();
  if(d.phase!=='lobby' || d.seats.some(s=>!s)) return;
  log('Shuffling and dealing...'); await sleep(400);
  const {hands,flowers,wall,dealer} = dealGame();
  await updateDoc(tableRef, {phase:'playing',turn:dealer,turnPhase:'draw',turnSeq:1,dealer,
    hands:seatArrOut(hands),melds:meldsOut([[],[],[],[]]),flowers:seatArrOut(flowers),discards:[],wall,
    drawn:null,pending:null,winner:null,log:'Shuffled and dealt — first player, draw a tile.'});
}

async function newHand(){
  const snap = await getDoc(tableRef); if(!snap.exists()) return; const d = snap.data();
  if(d.phase!=='ended') return;
  const {hands,flowers,wall,dealer} = dealGame();
  await updateDoc(tableRef, {phase:'playing',turn:dealer,turnPhase:'draw',turnSeq:(d.turnSeq||0)+1,dealer,
    hands:seatArrOut(hands),melds:meldsOut([[],[],[],[]]),flowers:seatArrOut(flowers),discards:[],wall,
    drawn:null,pending:null,winner:null,log:'New hand dealt — first player, draw a tile.'});
}

// ------------------------------------------------------------------- play
async function doDraw(){
  const snap = await getDoc(tableRef); const d = normalizeState(snap.data());
  if(d.phase!=='playing' || d.turn!==mySeat || d.turnPhase!=='draw') return;
  let wall=d.wall.slice(), hands=d.hands.map(h=>h.slice()), flowers=d.flowers.map(f=>f.slice());
  if(!wall.length){ await updateDoc(tableRef, {phase:'ended',winner:null,log:'The wall is empty — draw game.'}); return; }
  let t = wall.shift();
  while(t!==undefined && t>=34 && wall.length){ flowers[mySeat].push(t); t = wall.pop(); }
  hands[mySeat].push(t);
  await updateDoc(tableRef, {wall,hands:seatArrOut(hands),flowers:seatArrOut(flowers),drawn:{seat:mySeat,tile:t},turnPhase:'discard',turnSeq:d.turnSeq+1,
    log:'Drew a tile — your move.'});
}

async function declareSelfWin(){
  const snap = await getDoc(tableRef); const d = normalizeState(snap.data());
  if(d.turn!==mySeat || d.turnPhase!=='discard') return;
  if(!canWin(d.hands[mySeat], need(d,mySeat))) return;
  await updateDoc(tableRef, {phase:'ended',winner:{seat:mySeat,self:true},log:'Mahjong by self-draw!'});
}

async function doDiscard(tileVal){
  const snap = await getDoc(tableRef); const d = normalizeState(snap.data());
  if(d.turn!==mySeat || d.turnPhase!=='discard') return;
  const hands = d.hands.map(h=>h.slice());
  const idx = hands[mySeat].indexOf(tileVal); if(idx<0) return;
  hands[mySeat].splice(idx,1);
  const discards = d.discards.concat([{t:tileVal,by:mySeat}]);
  const pending = {tile:tileVal,by:mySeat,deadline:Date.now()+8000};
  await updateDoc(tableRef, {hands:seatArrOut(hands),discards,drawn:null,phase:'claim',pending,log:'Waiting for claims (pong/chow/mahjong)...'});
  setTimeout(() => autoAdvance(mySeat,tileVal), 8500);
}

async function autoAdvance(discarder,tileVal){
  const snap = await getDoc(tableRef); if(!snap.exists()) return; const d = snap.data();
  if(d.phase==='claim' && d.pending && d.pending.tile===tileVal && d.pending.by===discarder){
    const nextSeat = (discarder+1)%4;
    await updateDoc(tableRef, {phase:'playing',turnPhase:'draw',turn:nextSeat,pending:null,log:'No claims — next player, draw a tile.'});
  }
}

async function claimPong(){
  const snap = await getDoc(tableRef); const d = normalizeState(snap.data());
  if(d.phase!=='claim' || !d.pending || d.pending.by===mySeat) return;
  const tv = d.pending.tile;
  if(d.hands[mySeat].filter(x=>x===tv).length<2) return;
  const hands=d.hands.map(h=>h.slice()), melds=d.melds.map(m=>m.slice()), discards=d.discards.slice();
  const last = discards[discards.length-1];
  if(last && last.t===tv && last.by===d.pending.by) discards.pop();
  removeTiles(hands[mySeat],[tv,tv]); melds[mySeat].push([tv,tv,tv]);
  await updateDoc(tableRef, {hands:seatArrOut(hands),melds:meldsOut(melds),discards,phase:'playing',turnPhase:'discard',turn:mySeat,turnSeq:d.turnSeq+1,
    drawn:null,pending:null,log:'Pong claimed — now discard.'});
}

async function claimChow(pair){
  const snap = await getDoc(tableRef); const d = normalizeState(snap.data());
  if(d.phase!=='claim' || !d.pending) return;
  const tv = d.pending.tile;
  if(d.pending.by !== (mySeat+3)%4) return;
  const hand = d.hands[mySeat];
  if(!pair.every(x=>hand.includes(x))) return;
  const hands=d.hands.map(h=>h.slice()), melds=d.melds.map(m=>m.slice()), discards=d.discards.slice();
  const last = discards[discards.length-1];
  if(last && last.t===tv && last.by===d.pending.by) discards.pop();
  removeTiles(hands[mySeat],pair); melds[mySeat].push([...pair,tv].sort((a,b)=>a-b));
  await updateDoc(tableRef, {hands:seatArrOut(hands),melds:meldsOut(melds),discards,phase:'playing',turnPhase:'discard',turn:mySeat,turnSeq:d.turnSeq+1,
    drawn:null,pending:null,log:'Chow claimed — now discard.'});
}

async function claimWin(){
  const snap = await getDoc(tableRef); const d = normalizeState(snap.data());
  if(d.phase!=='claim' || !d.pending || d.pending.by===mySeat) return;
  const tv = d.pending.tile;
  if(!canWin([...d.hands[mySeat],tv], need(d,mySeat))) return;
  await updateDoc(tableRef, {phase:'ended',winner:{seat:mySeat,self:false},log:'Mahjong on a discard!'});
}

// ----------------------------------------------------------------- render
function seatLabel(seat){ const s=state.seats[seat]; return s ? s.name : `Seat ${seat+1}`; }

function renderGame(){
  const ref0 = mySeat>=0 ? mySeat : 0;
  for(let seat=0; seat<4; seat++){
    const slot = (seat-ref0+4)%4;
    const el = $('s'+slot);
    const hand = state.hands[seat]||[];
    let body = (state.melds[seat]||[]).map(m=>`<div class="meld">${m.map(t=>tile(t,'s')).join('')}</div>`).join('');
    if(seat===mySeat){
      body += myOrder.map((t,idx) => {
        const isNew = state.drawn && state.drawn.seat===mySeat && idx===myOrder.length-1 && state.drawn.tile===t;
        return tile(t, `pick ${isNew?'new':''} ${selectedIdx===idx?'selected':''}`, idx);
      }).join('');
    } else body += hand.map(back).join('');
    const fl = (state.flowers[seat]||[]).map(t=>tile(t,'s')).join('');
    const name = seatLabel(seat);
    el.className = 'seat'+(slot===3||slot===1?' v':'')+(state.phase==='playing'&&state.turn===seat?' myturn':'');
    el.innerHTML = `<b>${escapeHtml(name)}${state.dealer===seat?' · Dealer':''}${seat===mySeat?' (you)':''}</b> <span style="opacity:.7">${(state.flowers[seat]||[]).length?'· flowers:':''}</span> ${fl}<div class="row">${body}</div>`;
  }
  $('disc').innerHTML = (state.discards||[]).map(d=>tile(d.t,'d')).join('');
  log(state.log||'');
  attachHandHandlers();
  renderActions();
}

function attachHandHandlers(){
  document.querySelectorAll('#s0 .pick').forEach(el => {
    el.onclick = () => { const idx=+el.dataset.idx; selectedIdx=(selectedIdx===idx)?-1:idx; renderGame(); };
    el.draggable = true;
    el.ondragstart = e => { e.dataTransfer.setData('text/plain', el.dataset.idx); e.dataTransfer.effectAllowed='move'; };
    el.ondragover = e => e.preventDefault();
    el.ondrop = e => { e.preventDefault(); const from=+e.dataTransfer.getData('text/plain'), to=+el.dataset.idx;
      if(from===to||isNaN(from)) return; const [m]=myOrder.splice(from,1); myOrder.splice(to,0,m); selectedIdx=-1; renderGame(); };
  });
}

function renderActions(){
  const a = $('act'); a.innerHTML='';$('newHandBtn').style.display = state.phase==='ended' ? 'inline-block' : 'none';
  if(mySeat<0 || state.phase==='ended') return;
  if(state.phase==='playing' && state.turn===mySeat){
    if(state.turnPhase==='draw'){
      const b=document.createElement('button'); b.textContent='Draw tile'; b.onclick=doDraw; a.appendChild(b);
    } else if(state.turnPhase==='discard'){
      if(selectedIdx>=0 && myOrder[selectedIdx]!=null){
        const t = myOrder[selectedIdx];
        const info=document.createElement('span'); info.className='tile-info'; info.textContent=`${glyph(t)} ${tileOverview(t)}`; a.appendChild(info);
        const btn=document.createElement('button'); btn.textContent='Discard selected tile';
        btn.onclick=()=>{selectedIdx=-1;doDiscard(t);}; a.appendChild(btn);
      }
      if(canWin(state.hands[mySeat], need(state,mySeat))){
        const w=document.createElement('button'); w.textContent='🀄 Declare Mahjong!'; w.style.background='#e8b84a';
        w.onclick=declareSelfWin; a.appendChild(w);
      }
    }
  } else if(state.phase==='claim' && state.pending && state.pending.by!==mySeat){
    const tv = state.pending.tile, hand = state.hands[mySeat]||[];
    const canW = canWin([...hand,tv], need(state,mySeat));
    const canP = hand.filter(x=>x===tv).length>=2;
    const chows = (state.pending.by===(mySeat+3)%4) ? chowOptions(hand,tv) : [];
    if(canW||canP||chows.length){
      const note=document.createElement('span'); note.className='tile-info';
      note.textContent=`${glyph(tv)} ${tileName(tv)} was discarded — claim it?`; a.appendChild(note);
    }
    if(canW){ const b=document.createElement('button'); b.textContent='Mahjong!'; b.onclick=claimWin; a.appendChild(b); }
    if(canP){ const b=document.createElement('button'); b.textContent='Pong'; b.onclick=claimPong; a.appendChild(b); }
    chows.forEach(pair => { const b=document.createElement('button');
      b.textContent='Chow '+[...pair,tv].sort((a,b)=>a-b).map(glyph).join('');
      b.onclick=()=>claimChow(pair); a.appendChild(b); });
  }
}

function celebrate(winner){
  if($('winOverlay').classList.contains('show')) return;
  const name = winner ? seatLabel(winner.seat) : null;
  $('winSub').textContent = winner ? `${name} wins ${winner.self?'by self-draw':'on a discard'} — 5 sets and a pair!` : 'The wall ran out — draw game.';
  const colors=['#e8b84a','#f4efe0','#2c8a63','#fbf6e6','#c0392b'];
  $('confetti').innerHTML = Array.from({length:70}, () => {
    const left=Math.random()*100, delay=Math.random()*1.4, dur=2+Math.random()*1.6, c=colors[Math.random()*colors.length|0];
    return `<span style="left:${left}%;background:${c};animation-delay:${delay}s;animation-duration:${dur}s"></span>`;
  }).join('');
  const ov = $('winOverlay'); ov.classList.remove('hidden'); requestAnimationFrame(()=>ov.classList.add('show'));
}