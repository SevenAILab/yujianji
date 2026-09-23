// Same-origin gateway keeps service and provider keys out of the browser.
const apiBase = '/api/memory-3d';
const tokenKey = 'memory-universe-capability-v1';
let token;
function capability() {
  if (token) return token;
  token = localStorage.getItem(tokenKey);
  if (!/^[a-f0-9]{64}$/.test(token || '')) {
    token = [...crypto.getRandomValues(new Uint8Array(32))].map(n => n.toString(16).padStart(2, '0')).join('');
    localStorage.setItem(tokenKey, token);
  }
  return token;
}

export async function memoryFetch(path, options = {}) {
  const headers = new Headers(options.headers);
  headers.set('X-Universe-ID', capability());
  const response = await fetch(`${apiBase}/${path}`, {...options, headers, cache: 'no-store', signal: options.signal || AbortSignal.timeout(path.startsWith('models/') ? 180000 : 60000)});
  if (!response.ok) {
    let message = '记忆服务暂时不可用，请稍后重试';
    try {
      const body = await response.json();
      if (typeof body.detail === 'string') message = body.detail;
      else if (typeof body.error === 'string') message = body.error;
    } catch { /* Keep a readable fallback for proxy failures. */ }
    throw new Error(message);
  }
  return response;
}

const states = {
  queued: '正在排队', processing: '正在准备照片', submitted: '已提交生成',
  queued_upstream: '正在等待建模', running: '正在生成模型', downloading: '正在接入宇宙',
  ready: '模型已就绪', paused: '生成进度已保存', download_failed: '模型已生成，等待下载',
  submission_unknown: '提交结果待核对，请勿重复生成', upload_failed: '上传未完成，请联系管理员',
  failed: '生成失败，请联系管理员', cancelled: '生成已取消', error: '任务待核对，请联系管理员',
};

export function startMemoryClient(onModels) {
  const dialog = document.querySelector('#memory-dialog');
  const form = document.querySelector('#memory-form');
  const file = document.querySelector('#memory-photo');
  const name = document.querySelector('#memory-name');
  const status = document.querySelector('#memory-status');
  const list = document.querySelector('#memory-jobs');
  const submit = document.querySelector('#memory-submit');
  const error = document.querySelector('#memory-error');
  const preview = document.querySelector('#memory-preview');
  let busy = false, polling = false, previewUrl;

  const dialogState = open => {
    if (window.parent !== window) window.parent.postMessage({type: 'memory-universe:dialog', open}, location.origin);
  };
  document.querySelector('#add-memory').onclick = () => { dialog.showModal(); dialogState(true); };
  dialog.addEventListener('close', () => dialogState(false));
  document.querySelector('#memory-close').onclick = () => dialog.close();
  file.onchange = () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    const photo = file.files[0];
    preview.hidden = !photo;
    if (photo) {
      previewUrl = URL.createObjectURL(photo);
      preview.src = previewUrl;
      name.value = photo.name.replace(/\.[^.]+$/, '').slice(0, 100);
    }
    error.textContent = '';
  };
  const mode = document.querySelector('#memory-mode');
  mode.onchange = () => { document.querySelector('#memory-category-label').hidden = mode.value === 'environment'; };

  async function refresh() {
    if (polling) return;
    polling = true;
    try {
      const {jobs} = await (await memoryFetch('jobs')).json();
      list.replaceChildren();
      const active = jobs.filter(job => ['queued', 'processing', 'submitted', 'queued_upstream', 'running', 'downloading'].includes(job.state));
      status.textContent = active.length ? `${active.length} 件记忆正在形成 · 可离开页面，稍后回来` : jobs.length ? `${jobs.filter(j => j.state === 'ready').length} 件记忆已生成` : '上传第一张照片，让记忆在这里生长';
      for (const job of jobs.slice(-6).reverse()) {
        const item = document.createElement('li');
        const title = document.createElement('strong'); title.textContent = job.name;
        const text = document.createElement('span');
        text.textContent = `${states[job.state] || '正在查询'}${job.state === 'running' ? ` · ${job.progress}%` : ''}`;
        item.append(title, text);
        if (job.error) { const detail = document.createElement('small'); detail.textContent = job.error; item.append(detail); }
        if (['paused', 'download_failed'].includes(job.state) && job.generation_id) {
          const button = document.createElement('button'); button.type = 'button'; button.textContent = '继续查询 / 下载';
          button.onclick = async () => {
            button.disabled = true;
            try { await memoryFetch(`jobs/${job.id}/resume`, {method: 'POST'}); await refresh(); }
            catch (e) { error.textContent = e.message; }
            finally { button.disabled = false; }
          };
          item.append(button);
        }
        list.append(item);
      }
      await onModels(jobs.filter(j => j.state === 'ready').sort((a,b) => (a.completed || a.created) - (b.completed || b.created) || a.id.localeCompare(b.id)).map(j => ({id: j.id, name: j.name, url: j.model_url})));
    } catch (e) {
      status.textContent = e.message || '暂时连接不上记忆服务，正在尝试恢复';
    } finally { polling = false; }
  }

  form.onsubmit = async event => {
    event.preventDefault();
    if (busy) return;
    const photo = file.files[0];
    if (!photo) return;
    if (photo.size > 20 * 1024 * 1024) { error.textContent = '请选择 20 MB 以内的照片'; return; }
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(photo.type)) { error.textContent = '请选择 JPEG、PNG 或 WebP 照片'; return; }
    busy = true; submit.disabled = true; submit.textContent = '正在上传…'; error.textContent = '';
    try {
      const label = name.value.trim() || '新的记忆';
      const category = mode.value === 'environment' ? 'building' : document.querySelector('#memory-category').value;
      const photoDigest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', await photo.arrayBuffer()))].map(n => n.toString(16).padStart(2, '0')).join('');
      // The same file/settings always reuse the same billable operation, even after a lost response/reload.
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([photoDigest, label, category, mode.value])));
      const idem = [...new Uint8Array(digest)].map(n => n.toString(16).padStart(2, '0')).join('');
      const data = new FormData();
      data.set('file', photo); data.set('name', label); data.set('category', category); data.set('input_mode', mode.value);
      await memoryFetch('jobs', {method: 'POST', headers: {'Idempotency-Key': idem}, body: data});
      file.value = ''; preview.hidden = true;
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      dialog.close();
      await refresh();
    } catch (e) { error.textContent = `${e.message || '上传连接中断'}。可以重试同一张照片，已接收的任务不会重复生成。`; }
    finally { busy = false; submit.disabled = false; submit.textContent = '生成并加入宇宙'; }
  };
  refresh();
  const timer = setInterval(() => { if (!document.hidden) refresh(); }, 5000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  window.addEventListener('pagehide', () => clearInterval(timer), {once: true});
}
