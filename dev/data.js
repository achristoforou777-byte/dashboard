// Supabase data layer + login + settings for the standalone app.
// Exposes window.APP.start(onReady) and keeps the same collection/doc API the page uses.
(() => {
  const C = window.CFG;
  const sb = supabase.createClient(C.url, C.key, { auth: { persistSession: true, autoRefreshToken: true, storageKey: 'dash-' + C.env } });
  let UID = null, EMAIL = '', chan = null;
  const store = {}, listeners = {}, COLS = ['projects', 'tasks', 'tx', 'notes', 'rec'];
  const rid = () => Array.from(crypto.getRandomValues(new Uint8Array(10)), b => b.toString(36).padStart(2, '0')).join('').slice(0, 20);
  const emit = c => { const docs = [...(store[c] || new Map()).entries()].map(([id, d]) => ({ id, data: () => d })); (listeners[c] || []).forEach(f => f({ docs, metadata: { fromCache: false } })) };
  const put = (c, id, d) => (store[c] ??= new Map()).set(id, d);

  async function loadAll() {
    const rows = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await sb.from('dash_docs').select('col,id,data').eq('user_id', UID).range(from, from + 999);
      if (error) throw error;
      rows.push(...data); if (data.length < 1000) break;
    }
    COLS.forEach(c => store[c] = new Map());
    rows.forEach(r => put(r.col, r.id, r.data));
    COLS.forEach(emit);
  }
  function live() {
    chan?.unsubscribe();
    chan = sb.channel('dash-' + UID).on('postgres_changes', { event: '*', schema: 'public', table: 'dash_docs', filter: 'user_id=eq.' + UID }, p => {
      if (p.eventType === 'DELETE') { const o = p.old || {}; if (o.col && store[o.col]) { store[o.col].delete(o.id); emit(o.col) } }
      else { const n = p.new; put(n.col, n.id, n.data); emit(n.col) }
    }).subscribe();
  }
  function docRef(c, id) {
    return {
      id,
      async set(d) { put(c, id, d); emit(c); const { error } = await sb.from('dash_docs').upsert({ user_id: UID, col: c, id, data: d, updated_at: new Date().toISOString() }); if (error) { await loadAll(); throw error } },
      async update(p) { const cur = store[c]?.get(id); if (!cur) throw { code: 'invalid_argument' }; return this.set({ ...cur, ...p }) },
      async delete() { store[c]?.delete(id); emit(c); const { error } = await sb.from('dash_docs').delete().match({ user_id: UID, col: c, id }); if (error) { await loadAll(); throw error } }
    }
  }
  const db = { collection: c => ({ onSnapshot(cb) { (listeners[c] ??= []).push(cb); if (store[c]) cb({ docs: [...store[c].entries()].map(([id, d]) => ({ id, data: () => d })), metadata: { fromCache: false } }); return () => {} }, doc: id => docRef(c, id || rid()) }) };

  // ---------- login screen ----------
  const auth = document.getElementById('auth');
  function authView(mode, note = '') {
    const sign = mode === 'signup';
    auth.innerHTML = mode === 'denied'
      ? `<div class="authcard glass"><span class="logo" style="width:54px;height:54px;font-size:20px;border-radius:16px">AC</span><h2>Περιμένει έγκριση</h2><p class="sub">Συνδέθηκες ως <b>${EMAIL}</b>. Ο λογαριασμός δεν έχει ακόμα πρόσβαση στον πίνακα.</p><button class="btn" id="aout">Αποσύνδεση</button></div>`
      : `<form class="authcard glass" id="af"><span class="logo" style="width:54px;height:54px;font-size:20px;border-radius:16px">AC</span><h2>${sign ? 'Δημιουργία λογαριασμού' : 'Ο πίνακάς μου'}</h2><p class="sub">${sign ? 'Μία φορά μόνο, με το email σου.' : 'Συνδέσου για να δεις τα projects σου.'}</p>
        <label>Email<input name="email" type="email" autocomplete="username" required></label>
        <label>Κωδικός<input name="pw" type="password" autocomplete="${sign ? 'new-password' : 'current-password'}" minlength="8" required></label>
        ${note ? `<p class="anote">${note}</p>` : ''}<button class="cta" style="justify-content:center">${sign ? 'Δημιουργία' : 'Σύνδεση'}</button>
        <button type="button" class="tt" id="asw" style="text-align:center;color:var(--mute);font-size:14px">${sign ? 'Έχω ήδη λογαριασμό' : 'Πρώτη φορά; Δημιουργία λογαριασμού'}</button></form>`;
    auth.style.display = 'grid';
    auth.querySelector('#asw')?.addEventListener('click', () => authView(sign ? 'login' : 'signup'));
    auth.querySelector('#aout')?.addEventListener('click', () => sb.auth.signOut().then(() => authView('login')));
    auth.querySelector('#af')?.addEventListener('submit', async e => {
      e.preventDefault(); const f = new FormData(e.target), email = f.get('email').trim(), password = f.get('pw');
      const r = sign ? await sb.auth.signUp({ email, password }) : await sb.auth.signInWithPassword({ email, password });
      if (r.error) return authView(mode, r.error.message.includes('Invalid login') ? 'Λάθος email ή κωδικός.' : r.error.message.includes('confirmed') ? 'Επιβεβαίωσε πρώτα το email σου (δες τα εισερχόμενα).' : r.error.message);
      if (sign && !r.data.session) return authView('login', 'Σου στείλαμε email επιβεβαίωσης. Πάτα το link και μετά συνδέσου εδώ.');
    });
  }

  // ---------- push (iPhone only) ----------
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = () => navigator.standalone || matchMedia('(display-mode: standalone)').matches;
  const b64 = s => { const p = '='.repeat((4 - s.length % 4) % 4), r = atob((s + p).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(r, c => c.charCodeAt(0)) };
  async function pushState() {
    if (!isIOS) return 'notios'; if (!standalone()) return 'install'; if (!('serviceWorker' in navigator) || !('PushManager' in window)) return 'unsupported';
    const reg = await navigator.serviceWorker.ready, s = await reg.pushManager.getSubscription();
    return s && Notification.permission === 'granted' ? 'on' : 'off';
  }
  async function enablePush() {
    const p = await Notification.requestPermission(); if (p !== 'granted') throw new Error('denied');
    const reg = await navigator.serviceWorker.ready;
    const s = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64(C.vapid) });
    const { error } = await sb.from('dash_push').upsert({ endpoint: s.endpoint, user_id: UID, sub: s.toJSON(), ua: navigator.userAgent.slice(0, 200) });
    if (error) throw error;
  }
  async function disablePush() { const reg = await navigator.serviceWorker.ready, s = await reg.pushManager.getSubscription(); if (s) { await sb.from('dash_push').delete().eq('endpoint', s.endpoint); await s.unsubscribe() } }

  async function settings(dlg, toast) {
    const st = await pushState();
    const push = {
      notios: '<p class="sub" style="margin:0">Οι ειδοποιήσεις έρχονται μόνο στο iPhone σου, κάθε πρωί στις 08:00.</p>',
      install: '<p class="sub" style="margin:0">Για ειδοποιήσεις, πρόσθεσε πρώτα την εφαρμογή στην οθόνη Αφετηρίας:<br>1. Πάτα το κουμπί <b>Κοινοποίηση</b> (τετράγωνο με βέλος) στο Safari<br>2. Διάλεξε <b>Προσθήκη στην οθόνη Αφετηρίας</b><br>3. Άνοιξε την εφαρμογή από το εικονίδιο και έλα ξανά εδώ.</p>',
      unsupported: '<p class="sub" style="margin:0">Αυτό το iPhone χρειάζεται iOS 16.4 ή νεότερο για ειδοποιήσεις.</p>',
      off: '<p class="sub" style="margin:0">Κάθε πρωί στις 08:00 τα tasks της ημέρας και τα καθυστερημένα.</p><button type="button" class="cta" id="pon" style="justify-content:center">Ενεργοποίηση ειδοποιήσεων</button>',
      on: '<p class="sub" style="margin:0"><b style="color:var(--good)">Ενεργές ✓</b> · κάθε πρωί στις 08:00</p><div class="fb" style="justify-content:flex-start"><button type="button" class="btn" id="ptest">Στείλε δοκιμαστική</button><button type="button" class="btn red" id="poff">Απενεργοποίηση</button></div>'
    }[st];
    dlg.innerHTML = `<form class="glass" onsubmit="return false"><h2>Ρυθμίσεις</h2><p class="sub">${EMAIL}${C.env === 'dev' ? ' · <b style="color:#ffc75f">ΔΟΚΙΜΑΣΤΙΚΟ</b>' : ''}</p>
      <div class="sbox"><b>Ειδοποιήσεις</b>${push}</div>
      <div class="fb" style="justify-content:flex-start"><button type="button" class="btn" data-act="bg">Αλλαγή φόντου</button><button type="button" class="btn" id="exp">Εξαγωγή δεδομένων</button><button type="button" class="btn red" id="out">Αποσύνδεση</button></div>
      <div class="fb"><button type="button" class="btn" data-act="close">Κλείσιμο</button></div></form>`;
    const q = s => dlg.querySelector(s);
    q('#pon')?.addEventListener('click', async () => { try { await enablePush(); toast('Οι ειδοποιήσεις ενεργοποιήθηκαν'); settings(dlg, toast) } catch (e) { toast(e.message === 'denied' ? 'Δεν δόθηκε άδεια. Άλλαξέ το από Ρυθμίσεις iPhone → Ειδοποιήσεις.' : 'Δεν ενεργοποιήθηκαν: ' + e.message) } });
    q('#poff')?.addEventListener('click', async () => { await disablePush(); toast('Οι ειδοποιήσεις απενεργοποιήθηκαν'); settings(dlg, toast) });
    q('#ptest')?.addEventListener('click', async () => { const { data, error } = await sb.functions.invoke('dash-push', { body: { test: true } }); toast(error ? 'Αποτυχία αποστολής' : data?.sent ? 'Στάλθηκε, κοίτα την οθόνη σου' : 'Δεν βρέθηκε συσκευή, ενεργοποίησε ξανά') });
    q('#exp').addEventListener('click', () => { const o = { exported: new Date().toISOString() }; COLS.forEach(c => o[c] = [...(store[c] || new Map()).entries()].map(([id, d]) => ({ id, ...d }))); const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(o, null, 2)], { type: 'application/json' })); a.download = `pinakas-${new Date().toISOString().slice(0, 10)}.json`; a.click(); toast('Το αρχείο κατέβηκε') });
    q('#out').addEventListener('click', async () => { dlg.close(); await sb.auth.signOut(); location.reload() });
    if (!dlg.open) dlg.showModal();
  }

  async function start(onReady, onError) {
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
    let booted = false;
    const boot = async session => {
      if (!session) { UID = null; return authView('login') }
      UID = session.user.id; EMAIL = session.user.email;
      const { data: own } = await sb.from('dash_owners').select('user_id').eq('user_id', UID).maybeSingle();
      if (!own) return authView('denied');
      auth.style.display = 'none';
      if (booted) return; booted = true;
      try { await loadAll(); live(); onReady(db) } catch (e) { onError(e) }
    };
    const { data } = await sb.auth.getSession();
    await boot(data.session);
    sb.auth.onAuthStateChange((ev, s) => { if (ev === 'SIGNED_IN' && !booted) boot(s); if (ev === 'SIGNED_OUT') location.reload() });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && booted) loadAll().then(live).catch(() => {}) });
  }
  window.APP = { start, settings };
})();
