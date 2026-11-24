// Supabase data layer + access-code lock + settings for the standalone app.
// No accounts or email: one access code, typed once per device and kept on that device.
(() => {
  const C = window.CFG;
  const KEY = 'dash-key-' + C.env;
  let sb = null, timer = null;
  const store = {}, listeners = {}, COLS = ['projects', 'tasks', 'tx', 'notes', 'rec'];
  const rid = () => Array.from(crypto.getRandomValues(new Uint8Array(10)), b => b.toString(36).padStart(2, '0')).join('').slice(0, 20);
  const emit = c => { const docs = [...(store[c] || new Map()).entries()].map(([id, d]) => ({ id, data: () => d })); (listeners[c] || []).forEach(f => f({ docs, metadata: { fromCache: false } })) };
  const put = (c, id, d) => (store[c] ??= new Map()).set(id, d);
  const client = k => supabase.createClient(C.url, C.key, { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: k ? { 'x-dash-key': k } : {} } });
  const getKey = () => { try { return localStorage.getItem(KEY) } catch { return null } };
  const setKey = k => { try { k ? localStorage.setItem(KEY, k) : localStorage.removeItem(KEY) } catch {} };

  // ---------- Face ID / Touch ID (passkey on this device) ----------
  // The access code is encrypted with a key that only Face ID / Touch ID can release (WebAuthn PRF).
  const BIO = 'dash-bio-' + C.env;
  const isIOSdev = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const bioName = isIOSdev ? 'Face ID' : 'Touch ID';
  const enc = new TextEncoder(), dec = new TextDecoder();
  const u8 = n => crypto.getRandomValues(new Uint8Array(n));
  const toB = a => btoa(String.fromCharCode(...new Uint8Array(a)));
  const fromB = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  const getBio = () => { try { return JSON.parse(localStorage.getItem(BIO) || 'null') } catch { return null } };
  const setBio = v => { try { v ? localStorage.setItem(BIO, JSON.stringify(v)) : localStorage.removeItem(BIO) } catch {} };
  let curKey = null;
  async function bioOK() { try { return !!(window.PublicKeyCredential && await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()) } catch { return false } }
  async function bioAssert(rec) {
    const cred = await navigator.credentials.get({ publicKey: { challenge: u8(32), allowCredentials: [{ type: 'public-key', id: fromB(rec.id), transports: ['internal', 'hybrid'] }], userVerification: 'required', timeout: 60000, extensions: { prf: { eval: { first: fromB(rec.salt) } } } } });
    if (!cred) throw new Error('cancel');
    return cred.getClientExtensionResults()?.prf?.results?.first || null;
  }
  const aes = raw => crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
  async function bioEnable(k) {
    const salt = u8(32);
    const cred = await navigator.credentials.create({ publicKey: {
      rp: { name: 'uphill.cy' }, user: { id: enc.encode('uphill-' + C.env), name: 'uphill.cy' + (C.env === 'dev' ? ' (dev)' : ''), displayName: 'uphill.cy' },
      challenge: u8(32), pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
      authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'preferred' },
      timeout: 60000, extensions: { prf: { eval: { first: salt } } } } });
    const rec = { id: toB(cred.rawId), salt: toB(salt) };
    let secret = cred.getClientExtensionResults()?.prf?.results?.first;
    if (!secret) { try { secret = await bioAssert(rec) } catch (e) { if (e.name === 'NotAllowedError') throw e } }
    if (secret) {
      const iv = u8(12), ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aes(secret), enc.encode(k));
      Object.assign(rec, { prf: true, iv: toB(iv), ct: toB(ct) }); setBio(rec); setKey(null);
    } else { rec.prf = false; setBio(rec) }
  }
  async function bioUnlock() {
    const rec = getBio(), secret = await bioAssert(rec);
    if (!rec.prf) return getKey();
    if (!secret) throw new Error('noprf');
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB(rec.iv) }, await aes(secret), fromB(rec.ct));
    return dec.decode(pt);
  }

  let last = '';
  async function loadAll() {
    const rows = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await sb.from('dash_docs').select('col,id,data').order('col').order('id').range(from, from + 999);
      if (error) throw error;
      rows.push(...data); if (data.length < 1000) break;
    }
    const sig = JSON.stringify(rows); if (sig === last) return; last = sig;
    COLS.forEach(c => store[c] = new Map());
    rows.forEach(r => put(r.col, r.id, r.data));
    COLS.forEach(emit); avatar();
  }
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const prof = () => store.settings?.get('profile') || {};
  function avatar() {
    const u = store.settings?.get('profile')?.avatar;
    document.querySelectorAll('.me .av, .avbtn .av').forEach(el => { el.style.backgroundImage = u ? `url("${u}")` : ''; el.style.backgroundSize = 'cover'; el.style.backgroundPosition = 'center'; el.textContent = u ? '' : 'ΑΧ' });
  }
  function pickPhoto(toast) {
    const inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'image/*';
    inp.onchange = () => { const f = inp.files[0]; if (!f) return; const img = new Image(); img.onload = async () => {
      const s = Math.min(img.width, img.height), c = document.createElement('canvas'); c.width = c.height = 160;
      c.getContext('2d').drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, 160, 160);
      const url = c.toDataURL('image/jpeg', .85), prof = { ...(store.settings?.get('profile') || {}), avatar: url };
      put('settings', 'profile', prof); avatar();
      const { error } = await sb.from('dash_docs').upsert({ col: 'settings', id: 'profile', data: prof, updated_at: new Date().toISOString() });
      toast(error ? 'Η φωτογραφία δεν αποθηκεύτηκε' : 'Η φωτογραφία άλλαξε'); URL.revokeObjectURL(img.src) }; img.src = URL.createObjectURL(f) };
    inp.click();
  }
  function docRef(c, id) {
    return {
      id,
      async set(d) { put(c, id, d); emit(c); const { error } = await sb.from('dash_docs').upsert({ col: c, id, data: d, updated_at: new Date().toISOString() }); last = ''; if (error) { await loadAll(); throw error } },
      async update(p) { const cur = store[c]?.get(id); if (!cur) throw { code: 'invalid_argument' }; return this.set({ ...cur, ...p }) },
      async delete() { store[c]?.delete(id); emit(c); const { error } = await sb.from('dash_docs').delete().match({ col: c, id }); last = ''; if (error) { await loadAll(); throw error } }
    }
  }
  const db = { collection: c => ({ onSnapshot(cb) { (listeners[c] ??= []).push(cb); if (store[c]) cb({ docs: [...store[c].entries()].map(([id, d]) => ({ id, data: () => d })), metadata: { fromCache: false } }); return () => {} }, doc: id => docRef(c, id || rid()) }) };

  // ---------- access code screen ----------
  const lock = document.getElementById('auth');
  function lockView(first, note = '') {
    lock.innerHTML = `<form class="authcard glass" id="af"><img src="icon.svg" alt="" style="width:58px;height:58px;border-radius:16px">
      <h2>${first ? 'Όρισε κωδικό πρόσβασης' : 'uphill.cy'}</h2>
      <p class="sub">${first ? 'Διάλεξε έναν κωδικό (τουλάχιστον 8 χαρακτήρες). Θα τον γράφεις μία φορά σε κάθε συσκευή σου, iPhone και Mac.' : 'Γράψε τον κωδικό πρόσβασης. Θα σου τον ζητήσει μόνο αυτή τη φορά σε αυτή τη συσκευή.'}</p>
      <label>Κωδικός πρόσβασης<input name="k" type="password" autocomplete="${first ? 'new-password' : 'current-password'}" minlength="${first ? 8 : 6}" required></label>
      ${first ? '<label>Ξανά τον ίδιο κωδικό<input name="k2" type="password" autocomplete="new-password" minlength="8" required></label>' : ''}
      ${note ? `<p class="anote">${note}</p>` : ''}<button class="cta" style="justify-content:center">${first ? 'Αποθήκευση κωδικού' : 'Είσοδος'}</button>${!first && getBio() ? `<button type="button" class="btn" id="tobio" style="justify-content:center">Ξεκλείδωμα με ${bioName}</button>` : ''}</form>`;
    lock.style.display = 'grid';
    lock.querySelector('#tobio')?.addEventListener('click', () => bioView());
    lock.querySelector('#af').addEventListener('submit', async e => {
      e.preventDefault(); const f = new FormData(e.target), k = String(f.get('k'));
      const pub = client();
      if (first) {
        if (k !== f.get('k2')) return lockView(true, 'Οι δύο κωδικοί δεν είναι ίδιοι.');
        const { data, error } = await pub.rpc('dash_set_key', { k });
        if (error || !data) return lockView(false, 'Έχει ήδη οριστεί κωδικός. Γράψε αυτόν που όρισες.');
      } else {
        const { data, error } = await pub.rpc('dash_check_key', { k });
        if (error) return lockView(false, 'Δεν υπάρχει σύνδεση. Δοκίμασε ξανά.');
        if (!data) return lockView(false, 'Λάθος κωδικός.');
      }
      if (!getBio()?.prf) setKey(k);
      curKey = k; lock.style.display = 'none'; lock.classList.remove('solid'); go(k);
    });
  }

  let bioBusy = false;
  function bioView(note = '', auto = false) {
    document.querySelectorAll('dialog[open]').forEach(d => d.close());
    lock.classList.add('solid');
    lock.innerHTML = `<div class="authcard glass"><img src="icon.svg" alt="" style="width:58px;height:58px;border-radius:16px">
      <h2>uphill.cy</h2><p class="sub">Κλειδωμένο. Ξεκλείδωσε με ${bioName}.</p>
      ${note ? `<p class="anote">${note}</p>` : ''}
      <button type="button" class="cta" id="bgo" style="justify-content:center">Ξεκλείδωμα με ${bioName}</button>
      <button type="button" class="btn" id="bcode" style="justify-content:center">Χρήση κωδικού πρόσβασης</button></div>`;
    lock.style.display = 'grid';
    const tryIt = async () => {
      if (bioBusy) return; bioBusy = true;
      try {
        const k = curKey ? (await bioAssert(getBio()), curKey) : await bioUnlock();
        if (!k) throw new Error('nokey');
        lock.style.display = 'none'; lock.classList.remove('solid');
        if (!booted || k !== curKey) { curKey = k; const { data, error } = await client().rpc('dash_check_key', { k }); if (!error && !data) { setBio(null); setKey(null); curKey = null; return lockView(false, 'Ο κωδικός άλλαξε. Γράψε τον νέο κωδικό.') } go(k) }
      } catch (e) { bioView(auto && e.name === 'NotAllowedError' ? '' : 'Δεν έγινε ξεκλείδωμα. Δοκίμασε ξανά ή χρησιμοποίησε τον κωδικό.') }
      finally { bioBusy = false; auto = false }
    };
    lock.querySelector('#bgo').addEventListener('click', tryIt);
    lock.querySelector('#bcode').addEventListener('click', () => lockView(false));
    if (auto) tryIt();
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
    const { error } = await sb.from('dash_push').upsert({ endpoint: s.endpoint, sub: s.toJSON(), ua: navigator.userAgent.slice(0, 200) });
    if (error) throw error;
  }
  async function disablePush() { const reg = await navigator.serviceWorker.ready, s = await reg.pushManager.getSubscription(); if (s) { await sb.from('dash_push').delete().eq('endpoint', s.endpoint); await s.unsubscribe() } }

  async function settings(dlg, toast) {
    const st = await pushState(), canBio = await bioOK();
    const push = {
      notios: '<p class="sub" style="margin:0">Οι ειδοποιήσεις έρχονται μόνο στο iPhone σου, κάθε πρωί στις 08:00.</p>',
      install: '<p class="sub" style="margin:0">Για ειδοποιήσεις, πρόσθεσε πρώτα την εφαρμογή στην οθόνη Αφετηρίας:<br>1. Πάτα το κουμπί <b>Κοινοποίηση</b> (τετράγωνο με βέλος) στο Safari<br>2. Διάλεξε <b>Προσθήκη στην οθόνη Αφετηρίας</b><br>3. Άνοιξε την εφαρμογή από το εικονίδιο και έλα ξανά εδώ.</p>',
      unsupported: '<p class="sub" style="margin:0">Αυτό το iPhone χρειάζεται iOS 16.4 ή νεότερο για ειδοποιήσεις.</p>',
      off: '<p class="sub" style="margin:0">Κάθε πρωί στις 08:00 τα tasks της ημέρας και τα καθυστερημένα.</p><button type="button" class="cta" id="pon" style="justify-content:center">Ενεργοποίηση ειδοποιήσεων</button>',
      on: '<p class="sub" style="margin:0"><b style="color:var(--good)">Ενεργές ✓</b> · κάθε πρωί στις 08:00</p><div class="fb" style="justify-content:flex-start"><button type="button" class="btn" id="ptest">Στείλε δοκιμαστική</button><button type="button" class="btn red" id="poff">Απενεργοποίηση</button></div>'
    }[st];
    dlg.innerHTML = `<form class="glass" onsubmit="return false"><h2>Ρυθμίσεις</h2>${C.env === 'dev' ? '<p class="sub"><b style="color:#ffc75f">ΔΟΚΙΜΑΣΤΙΚΗ ΕΚΔΟΣΗ</b></p>' : ''}
      <div class="sbox"><b>Ξεκλείδωμα με ${bioName}</b>${!canBio ? `<p class="sub" style="margin:0">Αυτή η συσκευή δεν υποστηρίζει ${bioName}.</p>` : getBio() ? `<p class="sub" style="margin:0"><b style="color:var(--good)">Ενεργό ✓</b> · σου ζητά ${bioName} κάθε φορά που ανοίγεις την εφαρμογή</p><div class="fb" style="justify-content:flex-start"><button type="button" class="btn red" id="boff">Απενεργοποίηση</button></div>` : `<p class="sub" style="margin:0">Κάθε φορά που ανοίγεις την εφαρμογή θα σου ζητά ${bioName}. Ο κωδικός πρόσβασης μένει ως εφεδρικός.</p><button type="button" class="cta" id="bon" style="justify-content:center">Ενεργοποίηση ${bioName}</button>`}</div>
      <div class="sbox"><b>Ειδοποιήσεις</b>${push}</div>
      <div class="sbox"><b>Αυτοματισμοί</b>
      <label>Υπενθύμιση πριν από κάθε task με ώρα<select id="sr">${[[0,'Όχι'],[10,'10 λεπτά πριν'],[15,'15 λεπτά πριν'],[30,'30 λεπτά πριν'],[60,'1 ώρα πριν']].map(([v,l])=>`<option value="${v}" ${(+(prof().remind??30))===v?'selected':''}>${l}</option>`).join('')}</select></label>
      <label style="display:flex;align-items:center;gap:10px;color:var(--ink)"><input type="checkbox" id="sw" style="width:20px;height:20px;min-height:0" ${prof().weekly===false?'':'checked'}>Σύνοψη εβδομάδας κάθε Κυριακή 20:00</label>
      <label>Ειδοποίηση όταν ένας συνεργάτης μου χρωστάει πάνω από (€, 0 = ποτέ)<input id="sd" type="number" inputmode="decimal" min="0" step="10" value="${esc(prof().debt??0)}"></label>
      <p class="sub" style="margin:0">Η πρωινή ειδοποίηση στις 08:00 περιλαμβάνει πάντα τα tasks με τις ώρες τους και τις πληρωμές της ημέρας.</p></div>
      <div class="fb" style="justify-content:flex-start"><button type="button" class="btn" id="photo">Αλλαγή φωτογραφίας</button><button type="button" class="btn" data-act="bg">Αλλαγή φόντου</button><button type="button" class="btn" id="exp">Εξαγωγή δεδομένων</button><button type="button" class="btn red" id="out">Κλείδωμα συσκευής</button></div>
      <div class="fb"><button type="button" class="btn" data-act="close">Κλείσιμο</button></div></form>`;
    const q = s => dlg.querySelector(s);
    q('#pon')?.addEventListener('click', async () => { try { await enablePush(); toast('Οι ειδοποιήσεις ενεργοποιήθηκαν'); settings(dlg, toast) } catch (e) { toast(e.message === 'denied' ? 'Δεν δόθηκε άδεια. Άλλαξέ το από Ρυθμίσεις iPhone → Ειδοποιήσεις.' : 'Δεν ενεργοποιήθηκαν: ' + e.message) } });
    q('#bon')?.addEventListener('click', async () => { bioBusy = true; try { await bioEnable(curKey || getKey()); toast(bioName + ' ενεργοποιήθηκε'); settings(dlg, toast) } catch (e) { toast(e.name === 'NotAllowedError' ? 'Ακυρώθηκε' : 'Δεν ενεργοποιήθηκε: ' + (e.message || e.name)) } finally { setTimeout(() => bioBusy = false, 1500) } });
    q('#boff')?.addEventListener('click', () => { const k = curKey || getKey(); if (k) setKey(k); setBio(null); toast(bioName + ' απενεργοποιήθηκε'); settings(dlg, toast) });
    q('#poff')?.addEventListener('click', async () => { await disablePush(); toast('Οι ειδοποιήσεις απενεργοποιήθηκαν'); settings(dlg, toast) });
    q('#ptest')?.addEventListener('click', async () => { const { data, error } = await sb.functions.invoke('dash-push', { body: { test: true } }); toast(error ? 'Αποτυχία αποστολής' : data?.sent ? 'Στάλθηκε, κοίτα την οθόνη σου' : 'Δεν βρέθηκε συσκευή, ενεργοποίησε ξανά') });
    const saveProf = async patch => { const prf = { ...prof(), ...patch }; put('settings', 'profile', prf); const { error } = await sb.from('dash_docs').upsert({ col: 'settings', id: 'profile', data: prf, updated_at: new Date().toISOString() }); toast(error ? 'Δεν αποθηκεύτηκε' : 'Αποθηκεύτηκε') };
    q('#sr').addEventListener('change', e => saveProf({ remind: +e.target.value }));
    q('#sw').addEventListener('change', e => saveProf({ weekly: e.target.checked }));
    q('#sd').addEventListener('change', e => saveProf({ debt: Math.max(0, +e.target.value || 0) }));
    q('#photo').addEventListener('click', () => pickPhoto(toast));
    q('#exp').addEventListener('click', () => { const o = { exported: new Date().toISOString() }; COLS.forEach(c => o[c] = [...(store[c] || new Map()).entries()].map(([id, d]) => ({ id, ...d }))); const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(o, null, 2)], { type: 'application/json' })); a.download = `pinakas-${new Date().toISOString().slice(0, 10)}.json`; a.click(); toast('Το αρχείο κατέβηκε') });
    q('#out').addEventListener('click', () => { setKey(null); setBio(null); location.reload() });
    if (!dlg.open) dlg.showModal();
  }

  let onReady, onError, booted = false;
  async function go(k) {
    sb = client(k); curKey = k;
    try {
      await loadAll();
      if (!booted) { booted = true; onReady(db) }
      clearInterval(timer); timer = setInterval(() => { if (document.visibilityState === 'visible') loadAll().catch(() => {}) }, 20000);
    } catch (e) { onError(e) }
  }
  async function start(ready, error) {
    onReady = ready; onError = error;
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(() => {});
    let hiddenAt = 0;
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') { hiddenAt = Date.now(); return }
      if (getBio() && curKey && !bioBusy && hiddenAt && Date.now() - hiddenAt > 3000 && lock.style.display !== 'grid') bioView('', true);
      if (booted) loadAll().catch(() => {});
    });
    if (getBio()) return bioView('', true);
    const k = getKey();
    if (k) {
      const { data, error } = await client().rpc('dash_check_key', { k });
      if (error || data) return go(k);
      setKey(null);
    }
    const { data: has } = await client().rpc('dash_has_key');
    lockView(!has);
  }
  window.APP = { start, settings };
})();
