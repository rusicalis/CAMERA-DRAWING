(() => {
  'use strict';

  const $ = id => document.getElementById(id);
  const video = $('cameraVideo');
  const captureCanvas = $('captureCanvas');
  const captureCtx = captureCanvas.getContext('2d', { willReadFrequently: true });

  const state = {
    stream: null,
    captures: [],
    results: [],
    seq: 1,
    deferredInstall: null,
    working: false,
    arCalibration: null,
    lineCodes: [],
    lastNumbers: {},
    appMode: 'jig'
  };

  const MAX_ANALYSIS_SIDE = 1000;
  const MAX_CAPTURE_SIDE = 1600;

  function setStatus(text, kind='normal') {
    const el = $('statusPill');
    el.textContent = text;
    el.style.background = kind === 'ok' ? '#166534' : kind === 'warn' ? '#92400e' : kind === 'busy' ? '#075985' : '#334155';
  }

  function toast(text) {
    const el = $('toast');
    el.textContent = text;
    el.classList.add('show');
    clearTimeout(toast.t);
    toast.t = setTimeout(() => el.classList.remove('show'), 2200);
  }

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function n1(v) { return Number.isFinite(v) ? (Math.round(v * 10) / 10).toFixed(1) : ''; }
  function n2(v) { return Number.isFinite(v) ? (Math.round(v * 100) / 100).toFixed(2) : ''; }
  function ascii(s) { return String(s ?? '').replace(/[^\x20-\x7E]/g, '_'); }
  function safeName(s) { return String(s || 'HOOK').replace(/[\\/:*?"<>|\s]+/g, '_'); }

  // ---------------- Jig numbering / settings ----------------
  const LINE_CODES_KEY = 'hookDrawing.lineCodes.v064';
  const LAST_NUMBERS_KEY = 'hookDrawing.lastNumbers.v064';
  const DEFAULT_LINE_CODES = ['NNI','AG'];

  function padJigNo(n) { return String(clamp(Math.round(Number(n) || 1), 1, 999)).padStart(3,'0'); }
  function cleanLineCode(v) { return String(v || '').toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,10); }
  function currentLineCode() { return cleanLineCode($('lineCodeSelect').value) || 'NNI'; }
  function currentCaptureCode() { return state.appMode==='product' ? 'PRD' : currentLineCode(); }
  function currentRenderMode() { return state.appMode==='product' ? 'photo' : (($('renderModeSelect')?.value)||($('quickRenderModeSelect')?.value)||'drawing'); }
  function currentStraightenLevel() { return ($('straightenLevelSelect')?.value) || 'high'; }
  function straightenLevelLabel(v){ return v==='medium' ? '보통' : v==='max' ? '최대' : '강'; }
  function setRenderModeValue(mode){
    const safe = mode==='photo' ? 'photo' : 'drawing';
    if($('renderModeSelect')) $('renderModeSelect').value = safe;
    if($('quickRenderModeSelect')) $('quickRenderModeSelect').value = safe;
  }
  function setAppMode(mode) {
    state.appMode = mode==='product' ? 'product' : 'jig';
    $('tabJigBtn')?.classList.toggle('active', state.appMode==='jig');
    $('tabProductBtn')?.classList.toggle('active', state.appMode==='product');
    const product = state.appMode==='product';
    if(product){ setRenderModeValue('photo'); }
    else if(!currentRenderMode()) { setRenderModeValue('drawing'); }
    if($('renderModeSelect')) $('renderModeSelect').disabled = product;
    if($('quickRenderModeSelect')) $('quickRenderModeSelect').disabled = product;
    updateNumberPreview();
    if($('numberingMode').value==='continuous') renumberCaptures(true);
    renderCaptureList();
    renderResults();
  }
  function makeJigNumber(code, n) { return `${cleanLineCode(code) || 'NNI'}-${padJigNo(n)}`; }
  function parseJigNumber(v) {
    const m=String(v||'').toUpperCase().match(/^([A-Z0-9]{1,10})-(\d{1,3})$/);
    return m ? {code:m[1], number:parseInt(m[2],10)} : null;
  }

  function loadLineSettings() {
    let custom=[]; try { custom=JSON.parse(localStorage.getItem(LINE_CODES_KEY)||'[]'); } catch(_) {}
    state.lineCodes=[...new Set([...DEFAULT_LINE_CODES, ...(Array.isArray(custom)?custom:[]).map(cleanLineCode).filter(Boolean)])];
    try { state.lastNumbers=JSON.parse(localStorage.getItem(LAST_NUMBERS_KEY)||'{}') || {}; } catch(_) { state.lastNumbers={}; }
    renderLineCodes('NNI');
    suggestNextStart();
  }
  function saveLineCodes() { localStorage.setItem(LINE_CODES_KEY, JSON.stringify(state.lineCodes.filter(c=>!DEFAULT_LINE_CODES.includes(c)))); }
  function saveLastNumbers() { localStorage.setItem(LAST_NUMBERS_KEY, JSON.stringify(state.lastNumbers)); }
  function renderLineCodes(selected) {
    const sel=$('lineCodeSelect'); const keep=selected||sel.value||state.lineCodes[0]||'NNI';
    sel.innerHTML=state.lineCodes.map(c=>`<option value="${esc(c)}">${esc(c)}</option>`).join('');
    if(state.lineCodes.includes(keep)) sel.value=keep;
    updateNumberPreview();
  }
  function suggestNextStart() {
    const code=currentCaptureCode(); const next=clamp((parseInt(state.lastNumbers[code],10)||0)+1,1,999);
    $('startNumber').value=next; updateNumberPreview();
  }
  function updateNumberPreview() {
    const code=currentCaptureCode(); const start=clamp(parseInt($('startNumber').value,10)||1,1,999); const count=parseInt($('maxShots').value,10)||10;
    $('numberPreview').textContent=$('numberingMode').value==='continuous' ? `${makeJigNumber(code,start)} ~ ${makeJigNumber(code,Math.min(999,start+count-1))}` : `개별 입력 · 기본 ${makeJigNumber(code,start)}부터`;
  }
  function renumberCaptures(force=false) {
    if(!force && $('numberingMode').value!=='continuous') return;
    const code=currentCaptureCode(), start=clamp(parseInt($('startNumber').value,10)||1,1,999);
    state.captures.forEach((c,i)=>{ c.name=makeJigNumber(code,Math.min(999,start+i)); });
    renderCaptureList(); updateNumberPreview();
  }
  function persistUsedNumbers() {
    for(const c of [...state.captures, ...state.results]) {
      const p=parseJigNumber(c.name); if(!p) continue;
      state.lastNumbers[p.code]=Math.max(parseInt(state.lastNumbers[p.code],10)||0,p.number);
    }
    saveLastNumbers();
  }
  function addLineCode() {
    const code=cleanLineCode($('newLineCode').value);
    if(!code) return toast('라인 코드를 입력하세요.');
    if(!state.lineCodes.includes(code)){ state.lineCodes.push(code); saveLineCodes(); }
    renderLineCodes(code); $('newLineCode').value=''; suggestNextStart();
    toast(`${code} 라인코드를 저장했습니다.`);
  }
  function deleteLineCode() {
    const code=currentCaptureCode();
    if(DEFAULT_LINE_CODES.includes(code)) return toast('NNI와 AG 기본 코드는 삭제할 수 없습니다.');
    if(!confirm(`${code} 라인코드를 삭제할까요?`)) return;
    state.lineCodes=state.lineCodes.filter(c=>c!==code); saveLineCodes(); renderLineCodes('NNI'); suggestNextStart();
  }

  // ---------------- WebXR AR scale calibration ----------------
  function medianValue(values) {
    if(!values.length) return NaN; const a=values.slice().sort((x,y)=>x-y),m=a.length>>1; return a.length%2?a[m]:(a[m-1]+a[m])/2;
  }
  async function startArAutoMeasure() {
    if(state.working) return;
    stopCamera();
    const btn=$('arMeasureBtn'); btn.disabled=true; setStatus('AR 평면 탐색중','busy'); $('arStatus').textContent='평면 탐색중';
    try {
      if(!navigator.xr || !navigator.xr.isSessionSupported || !(await navigator.xr.isSessionSupported('immersive-ar'))) {
        throw new Error('이 브라우저는 WebXR AR 자동 측정을 지원하지 않습니다. Android Chrome에서 확인하거나 격자/대략치수를 사용하세요.');
      }
      const session=await navigator.xr.requestSession('immersive-ar',{requiredFeatures:['hit-test'],optionalFeatures:['dom-overlay'],domOverlay:{root:document.body}});
      const glCanvas=document.createElement('canvas'); const gl=glCanvas.getContext('webgl',{alpha:true,xrCompatible:true});
      if(!gl) throw new Error('AR 그래픽 초기화에 실패했습니다.');
      if(gl.makeXRCompatible) await gl.makeXRCompatible();
      const layer=new XRWebGLLayer(session,gl); session.updateRenderState({baseLayer:layer});
      const refSpace=await session.requestReferenceSpace('local'); const viewerSpace=await session.requestReferenceSpace('viewer');
      const hitSource=await session.requestHitTestSource({space:viewerSpace});
      const widths=[],distances=[]; let ended=false;
      const timeout=setTimeout(()=>{ if(!ended) session.end().catch(()=>{}); },15000);
      await new Promise((resolve,reject)=>{
        session.addEventListener('end',()=>{ended=true;clearTimeout(timeout);resolve();},{once:true});
        const frameLoop=(time,frame)=>{
          const pose=frame.getViewerPose(refSpace),hits=frame.getHitTestResults(hitSource);
          if(pose && hits.length){
            const hp=hits[0].getPose(refSpace),view=pose.views[0],vp=layer.getViewport(view);
            if(hp&&view&&vp){
              const a=view.transform.position,b=hp.transform.position,dist=Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z);
              const pm=view.projectionMatrix,fx=pm && Math.abs(pm[0])>.0001 ? Math.abs(pm[0]) : NaN;
              if(Number.isFinite(dist)&&dist>.08&&dist<3&&Number.isFinite(fx)){
                const fovX=2*Math.atan(1/fx),worldWidthMm=2*dist*Math.tan(fovX/2)*1000;
                if(worldWidthMm>50&&worldWidthMm<5000){ widths.push(worldWidthMm); distances.push(dist*1000); if(widths.length>24) session.end().catch(()=>{}); }
              }
            }
          }
          if(!ended) session.requestAnimationFrame(frameLoop);
        };
        session.requestAnimationFrame(frameLoop);
      });
      if(widths.length<6) throw new Error('평면을 안정적으로 측정하지 못했습니다. 치구 바닥면을 향해 휴대폰을 천천히 움직인 뒤 다시 시도하세요.');
      const fieldWidthMm=medianValue(widths.slice(-18)),distanceMm=medianValue(distances.slice(-18));
      state.arCalibration={fieldWidthMm,distanceMm,at:Date.now()};
      $('arStatus').textContent=`보정 완료 · 거리 약 ${Math.round(distanceMm)} mm`;
      setStatus('AR 보정 완료','ok'); toast('AR 스케일 보정 완료 · 같은 높이에서 촬영하세요.');
    } catch(err) {
      state.arCalibration=null; $('arStatus').textContent='사용 불가/실패'; setStatus('AR 확인 필요','warn');
      alert(`AR 자동 측정: ${err?.message||err}`);
    } finally { btn.disabled=false; }
  }

  // ---------------- Camera ----------------
  async function startCamera() {
    if (state.working) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      showCameraError('이 브라우저에서 앱 내부 카메라를 사용할 수 없습니다. HTTPS 주소에서 Safari/Chrome으로 실행했는지 확인하세요.');
      return;
    }
    try {
      stopCamera();
      setStatus('카메라 연결중', 'busy');
      const constraints = {
        audio: false,
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1920 },
          height: { ideal: 2560 }
        }
      };
      state.stream = await navigator.mediaDevices.getUserMedia(constraints);
      video.srcObject = state.stream;
      await video.play();
      $('cameraEmpty').classList.add('hidden');
      $('captureBtn').disabled = false;
      $('stopCameraBtn').disabled = false;
      $('startCameraBtn').textContent = '카메라 재시작';
      $('cameraError').classList.add('hidden');
      setStatus('촬영 가능', 'ok');
    } catch (err) {
      const msg = err?.name === 'NotAllowedError'
        ? '카메라 권한이 거부되었습니다. 휴대폰 설정에서 이 웹앱/사이트의 카메라 권한을 허용한 뒤 다시 시도하세요.'
        : `카메라 시작 실패: ${err?.message || err}`;
      showCameraError(msg);
      setStatus('카메라 확인 필요', 'warn');
    }
  }

  function stopCamera() {
    if (state.stream) {
      state.stream.getTracks().forEach(t => t.stop());
      state.stream = null;
    }
    video.srcObject = null;
    $('captureBtn').disabled = true;
    $('stopCameraBtn').disabled = true;
    $('cameraEmpty').classList.remove('hidden');
  }

  function showCameraError(msg) {
    const el = $('cameraError');
    el.textContent = msg;
    el.classList.remove('hidden');
  }

  function canvasToBlob(canvas, type='image/jpeg', quality=.88) {
    return new Promise((resolve, reject) => canvas.toBlob(b => b ? resolve(b) : reject(new Error('이미지 캡처 실패')), type, quality));
  }
  function blobToDataURL(blob){
    return new Promise((resolve,reject)=>{const fr=new FileReader();fr.onload=()=>resolve(String(fr.result||''));fr.onerror=()=>reject(new Error('이미지 읽기 실패'));fr.readAsDataURL(blob);});
  }
  async function addCaptureBlob(blob, sourceType='camera', originalName='') {
    const max = parseInt($('maxShots').value, 10) || 30;
    if (state.captures.length >= max) { toast(`최대 ${max}장까지 가능합니다.`); return false; }
    const url = URL.createObjectURL(blob);
    const code=currentCaptureCode(), start=clamp(parseInt($('startNumber').value,10)||1,1,999);
    const captureIndex=state.captures.length;
    const jigNo=makeJigNumber(code,Math.min(999,start+captureIndex));
    const freshAr=state.arCalibration && (Date.now()-state.arCalibration.at)<10*60*1000 ? state.arCalibration : null;
    const item = {
      id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}_${Math.random()}`,
      seq: state.seq++,
      blob, url, originalName, sourceType, captureType: state.appMode,
      name: jigNo,
      diameter: parseFloat($('defaultDiameter').value) || 6,
      material: $('defaultMaterial').value.trim() || 'SUS304',
      approxWidth: '',
      approxHeight: '',
      measureMode: $('measureMode').value || 'auto',
      arMmPerPx: freshAr ? freshAr.fieldWidthMm / 1000 : null,
      arDistanceMm: freshAr ? freshAr.distanceMm : null
    };
    state.captures.push(item);
    renderCaptureList();
    updateShotUI();
    setStatus(`${state.captures.length}장 촬영`, 'ok');
    updateNumberPreview();
    return true;
  }

  async function captureShot() {
    const max = parseInt($('maxShots').value, 10) || 10;
    if (!state.stream || !video.videoWidth || state.captures.length >= max) return;
    try {
      const vw = video.videoWidth, vh = video.videoHeight;
      const s = Math.min(1, MAX_CAPTURE_SIDE / Math.max(vw, vh));
      const w = Math.max(1, Math.round(vw * s));
      const h = Math.max(1, Math.round(vh * s));
      captureCanvas.width = w; captureCanvas.height = h;
      captureCtx.drawImage(video, 0, 0, w, h);
      const blob = await canvasToBlob(captureCanvas, 'image/jpeg', .90);
      // The hidden capture canvas must not retain the camera frame after the JPEG blob is created.
      captureCtx.clearRect(0, 0, captureCanvas.width, captureCanvas.height);
      captureCanvas.width = 1; captureCanvas.height = 1;
      await addCaptureBlob(blob,'camera');
      toast(`촬영 완료 · 사진첩 저장 안 함`);
      if (state.captures.length >= max) {
        $('captureBtn').disabled = true;
        toast(`최대 ${max}장 촬영 완료`);
      }
    } catch (err) {
      showCameraError(`촬영 실패: ${err?.message || err}`);
    }
  }

  function revokeCapture(item) {
    try { if (item.url) URL.revokeObjectURL(item.url); } catch (_) {}
    item.url = null; item.blob = null;
  }

  function clearCaptures() {
    state.captures.forEach(revokeCapture);
    state.captures = [];
    renderCaptureList();
    updateShotUI();
    setStatus('촬영 대기');
  }

  function updateShotUI() {
    const count = state.captures.length;
    $('shotCount').textContent = `${count}장`;
    $('clearShotsBtn').disabled = count === 0 || state.working;
    if($('queueSummaryCount')) $('queueSummaryCount').textContent = `${count}장`;
    $('batchAnalyzeBtn').disabled = count === 0 || state.working;
    if (state.stream) $('captureBtn').disabled = count >= (parseInt($('maxShots').value,10)||10) || state.working;
  }

  function renderCaptureList() {
    const host = $('captureList');
    if (!state.captures.length) {
      host.innerHTML = '<div class="empty-state">아직 촬영된/첨부된 사진이 없습니다.</div>';
      return;
    }
    host.innerHTML = state.captures.map((c, i) => `
      <div class="capture-item" data-id="${c.id}">
        <img class="capture-thumb" src="${c.url}" alt="촬영 ${i+1}">
        <div>
          <div class="capture-head"><b>${i+1}. ${esc(c.name)}</b><span class="capture-type-badge">${c.captureType==='product'?'제품':'치구'} · ${c.sourceType==='upload'?'첨부':'촬영'}</span><button class="icon-btn delete-shot" data-id="${c.id}">삭제</button></div>
          <div class="capture-fields">
            <label class="wide jig-no">치구번호<input data-field="name" value="${esc(c.name)}" maxlength="20" autocapitalize="characters"></label>
            <label>Ø mm<input data-field="diameter" type="number" min="0.5" max="50" step="0.1" value="${esc(c.diameter)}"></label>
            <label>재질<input data-field="material" value="${esc(c.material)}" maxlength="40"></label>
            <label>대략 폭 mm<input data-field="approxWidth" type="number" min="1" max="3000" step="1" value="${esc(c.approxWidth)}" placeholder="선택"></label>
            <label>대략 높이 mm<input data-field="approxHeight" type="number" min="1" max="3000" step="1" value="${esc(c.approxHeight)}" placeholder="선택"></label>
          </div>
          <span class="field-note">측정 모드: ${esc(c.measureMode==='ar'?'AR 우선':c.measureMode==='grid'?'격자 우선':c.measureMode==='manual'?'대략치수':'자동')} ${Number.isFinite(c.arMmPerPx)?`· AR 보정 있음 (거리 약 ${Math.round(c.arDistanceMm||0)} mm)`:''}</span>
        </div>
      </div>`).join('');
  }

  $('captureList').addEventListener('input', e => {
    const field = e.target.dataset?.field;
    if (!field) return;
    const row = e.target.closest('.capture-item');
    const item = state.captures.find(c => c.id === row?.dataset.id);
    if (!item) return;
    if (field==='name') { item[field]=String(e.target.value||'').toUpperCase(); }
    else item[field] = e.target.value;
  });

  $('captureList').addEventListener('click', e => {
    const btn = e.target.closest('.delete-shot');
    if (!btn || state.working) return;
    const idx = state.captures.findIndex(c => c.id === btn.dataset.id);
    if (idx < 0) return;
    revokeCapture(state.captures[idx]);
    state.captures.splice(idx, 1);
    if($('numberingMode').value==='continuous') renumberCaptures(true); else renderCaptureList();
    updateShotUI();
  });

  // ---------------- Image / analysis helpers ----------------
  async function blobToCanvas(blob, maxSide=MAX_ANALYSIS_SIDE) {
    const url = URL.createObjectURL(blob);
    try {
      const img = await new Promise((resolve, reject) => {
        const im = new Image();
        im.onload = () => resolve(im);
        im.onerror = () => reject(new Error('촬영 이미지를 읽지 못했습니다.'));
        im.src = url;
      });
      const s = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
      const w = Math.max(1, Math.round(img.naturalWidth * s));
      const h = Math.max(1, Math.round(img.naturalHeight * s));
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      const cx = c.getContext('2d', { willReadFrequently: true });
      cx.drawImage(img, 0, 0, w, h);
      return { canvas:c, ctx:cx, imageData:cx.getImageData(0,0,w,h), w, h, scale:s };
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  function grayArray(imageData) {
    const d = imageData.data, g = new Uint8Array(d.length / 4);
    for (let i=0,j=0; i<d.length; i+=4,j++) g[j] = (0.299*d[i] + 0.587*d[i+1] + 0.114*d[i+2]) | 0;
    return g;
  }

  function scanlinePeriod(values, minLag=6, maxLag=96) {
    const n=values.length;if(n<40)return{lag:0,score:0};
    const grad=new Float64Array(n);let mean=0;
    for(let i=1;i<n;i++){grad[i]=Math.abs(values[i]-values[i-1]);mean+=grad[i];}
    mean/=Math.max(1,n-1);let variance=0;
    for(let i=0;i<n;i++){grad[i]-=mean;variance+=grad[i]*grad[i];}
    if(variance<1e-6)return{lag:0,score:0};
    maxLag=Math.min(maxLag,Math.floor(n/3));const scores=new Float64Array(maxLag+1);let bestLag=0,best=-1;
    for(let lag=minLag;lag<=maxLag;lag++){let num=0,a2=0,b2=0;for(let i=0;i<n-lag;i+=2){const a=grad[i],b=grad[i+lag];num+=a*b;a2+=a*a;b2+=b*b;}const sc=num/(Math.sqrt(a2*b2)+1e-9);scores[lag]=sc;if(sc>best){best=sc;bestLag=lag;}}
    for(const div of [2,3,4]){const cand=Math.round(bestLag/div);if(cand<minLag)continue;const sc=scores[cand]||0;if(sc>.14&&sc>best*.48){bestLag=cand;best=sc;}}
    return{lag:bestLag,score:clamp(best,0,1)};
  }
  function clusteredPeriod(samples){const good=samples.filter(v=>v.lag>=6&&v.score>=.18);if(good.length<3)return{lag:0,score:0,support:0};let best=null;for(const c of good){const tol=Math.max(2,c.lag*.12),near=good.filter(v=>Math.abs(v.lag-c.lag)<=tol),weight=near.reduce((a,v)=>a+v.score,0);if(!best||weight>best.weight)best={near,weight};}if(!best||best.near.length<3)return{lag:0,score:0,support:0};const lags=best.near.map(v=>v.lag).sort((a,b)=>a-b),m=lags.length>>1,lag=lags.length%2?lags[m]:(lags[m-1]+lags[m])/2,score=best.near.reduce((a,v)=>a+v.score,0)/best.near.length;return{lag,score,support:best.near.length};}
  function detectGrid(gray,w,h){const rowSamples=[],colSamples=[],lineCount=14,minLag=Math.max(5,Math.floor(Math.min(w,h)/180)),maxLag=Math.min(110,Math.floor(Math.min(w,h)/5));for(let k=0;k<lineCount;k++){const y=clamp(Math.round(h*(.10+.80*k/(lineCount-1))),1,h-2),row=new Uint8Array(w);for(let x=0;x<w;x++)row[x]=gray[y*w+x];rowSamples.push(scanlinePeriod(row,minLag,maxLag));const x=clamp(Math.round(w*(.10+.80*k/(lineCount-1))),1,w-2),col=new Uint8Array(h);for(let yy=0;yy<h;yy++)col[yy]=gray[yy*w+x];colSamples.push(scanlinePeriod(col,minLag,maxLag));}const px=clusteredPeriod(rowSamples),py=clusteredPeriod(colSamples);if(!px.lag||!py.lag||px.support<5||py.support<5)return{pitch:null,confidence:0,reason:'양방향 격자 미검출'};const ratio=Math.max(px.lag,py.lag)/Math.max(1,Math.min(px.lag,py.lag));if(ratio>1.28)return{pitch:null,confidence:0,reason:'가로/세로 격자 간격 불일치'};const pitch=(px.lag*px.score+py.lag*py.score)/(px.score+py.score),support=Math.min(1,(px.support+py.support)/(lineCount*1.25)),balance=1-Math.min(.45,Math.abs(px.lag-py.lag)/Math.max(px.lag,py.lag)),confidence=clamp(((px.score+py.score)/2)*support*balance*1.32,0,.99);return confidence>=.32?{pitch,confidence,reason:`스캔라인 격자 ${px.support}/${py.support}`}:{pitch:null,confidence:0,reason:'격자 신뢰도 부족'};}

  function medianFromHist(hist,total){let acc=0,target=Math.max(1,Math.floor(total/2));for(let i=0;i<hist.length;i++){acc+=hist[i];if(acc>=target)return i;}return 0;}

  function dominantBackgroundYCbCr(imageData,w,h){
    // 이미지 전체의 중앙값을 사용한다. 치구가 화면의 일부만 차지한다는 촬영 조건에서
    // 녹색/청색 매트, 흰 격자지 모두 배경색 추정이 안정적이다.
    const hy=new Uint32Array(256),hcb=new Uint32Array(256),hcr=new Uint32Array(256),d=imageData.data;
    let n=0; const step=Math.max(1,Math.floor(Math.min(w,h)/260));
    for(let y=0;y<h;y+=step) for(let x=0;x<w;x+=step){
      const i=(y*w+x)*4,r=d[i],g=d[i+1],b=d[i+2];
      const yy=clamp(Math.round(.299*r+.587*g+.114*b),0,255);
      const cb=clamp(Math.round(128-.168736*r-.331264*g+.5*b),0,255);
      const cr=clamp(Math.round(128+.5*r-.418688*g-.081312*b),0,255);
      hy[yy]++;hcb[cb]++;hcr[cr]++;n++;
    }
    return {y:medianFromHist(hy,n),cb:medianFromHist(hcb,n),cr:medianFromHist(hcr,n)};
  }

  function backgroundDifferenceMask(imageData,w,h,pitchPx){
    const bg=dominantBackgroundYCbCr(imageData,w,h),d=imageData.data,raw=new Uint8Array(w*h);
    for(let p=0,i=0;p<raw.length;p++,i+=4){
      const r=d[i],g=d[i+1],b=d[i+2];
      const yy=.299*r+.587*g+.114*b;
      const cb=128-.168736*r-.331264*g+.5*b;
      const cr=128+.5*r-.418688*g-.081312*b;
      const chroma=Math.hypot(cb-bg.cb,cr-bg.cr),lum=Math.abs(yy-bg.y),bgSat=Math.hypot(bg.cb-128,bg.cr-128);
      // 색이 있는 촬영 매트에서는 색차를 주 기준으로 사용해 그림자를 제외한다.
      // 흰/회색 격자지에서는 명암차도 함께 사용한다.
      raw[p]=(bgSat>12 ? chroma>16 : (chroma>14||lum>45))?1:0;
    }
    const r=pitchPx?clamp(Math.round(pitchPx*.10),2,7):2;
    // 얇은 격자선은 밀도 필터에서 제거하고, 선재처럼 일정 두께가 있는 물체를 보존한다.
    let m=densityFilter(raw,w,h,r,pitchPx?.24:.18);
    m=dilate(m,w,h);m=erode(m,w,h);
    return {mask:m,bg};
  }

  function otsu(gray) {
    const hist=new Uint32Array(256);for(const v of gray)hist[v]++;
    const total=gray.length;let sum=0;for(let i=0;i<256;i++)sum+=i*hist[i];
    let sumB=0,wB=0,maxVar=0,thr=105;
    for(let t=0;t<256;t++){wB+=hist[t];if(!wB)continue;const wF=total-wB;if(!wF)break;sumB+=t*hist[t];const mB=sumB/wB,mF=(sum-sumB)/wF,v=wB*wF*(mB-mF)*(mB-mF);if(v>maxVar){maxVar=v;thr=t;}}
    return thr;
  }

  function integralMask(mask,w,h){const iw=w+1,out=new Uint32Array((w+1)*(h+1));for(let y=1;y<=h;y++){let row=0;for(let x=1;x<=w;x++){row+=mask[(y-1)*w+x-1];out[y*iw+x]=out[(y-1)*iw+x]+row;}}return out;}
  function boxSum(ii,w,h,x0,y0,x1,y1){const iw=w+1;x0=Math.max(0,x0);y0=Math.max(0,y0);x1=Math.min(w-1,x1);y1=Math.min(h-1,y1);return ii[(y1+1)*iw+x1+1]-ii[y0*iw+x1+1]-ii[(y1+1)*iw+x0]+ii[y0*iw+x0];}
  function densityFilter(raw,w,h,r,ratio){const ii=integralMask(raw,w,h),out=new Uint8Array(raw.length);for(let y=0;y<h;y++)for(let x=0;x<w;x++){const idx=y*w+x;if(!raw[idx])continue;const x0=Math.max(0,x-r),x1=Math.min(w-1,x+r),y0=Math.max(0,y-r),y1=Math.min(h-1,y+r),area=(x1-x0+1)*(y1-y0+1),sum=boxSum(ii,w,h,x0,y0,x1,y1);if(sum/area>=ratio)out[idx]=1;}return out;}
  function dilate(mask,w,h){const out=new Uint8Array(mask.length);for(let y=1;y<h-1;y++)for(let x=1;x<w-1;x++){let v=0;for(let dy=-1;dy<=1&&!v;dy++)for(let dx=-1;dx<=1;dx++)if(mask[(y+dy)*w+x+dx]){v=1;break;}out[y*w+x]=v;}return out;}
  function erode(mask,w,h){const out=new Uint8Array(mask.length);for(let y=1;y<h-1;y++)for(let x=1;x<w-1;x++){let v=1;for(let dy=-1;dy<=1&&v;dy++)for(let dx=-1;dx<=1;dx++)if(!mask[(y+dy)*w+x+dx]){v=0;break;}out[y*w+x]=v;}return out;}

  function integralGray(gray,w,h){const iw=w+1,out=new Uint32Array((w+1)*(h+1));for(let y=1;y<=h;y++){let row=0;for(let x=1;x<=w;x++){row+=gray[(y-1)*w+x-1];out[y*iw+x]=out[(y-1)*iw+x]+row;}}return out;}
  function adaptiveDarkMask(gray,w,h,pitchPx){const ii=integralGray(gray,w,h),out=new Uint8Array(gray.length),r=clamp(Math.round((pitchPx||30)*.34),8,18),bias=7,iw=w+1;for(let y=0;y<h;y++)for(let x=0;x<w;x++){const x0=Math.max(0,x-r),x1=Math.min(w-1,x+r),y0=Math.max(0,y-r),y1=Math.min(h-1,y+r),sum=ii[(y1+1)*iw+x1+1]-ii[y0*iw+x1+1]-ii[(y1+1)*iw+x0]+ii[y0*iw+x0],mean=sum/((x1-x0+1)*(y1-y0+1));if(gray[y*w+x]<mean-bias)out[y*w+x]=1;}return out;}
  function crossDilate(mask,w,h){const out=new Uint8Array(mask.length);for(let y=1;y<h-1;y++)for(let x=1;x<w-1;x++){const i=y*w+x;out[i]=(mask[i]||mask[i-1]||mask[i+1]||mask[i-w]||mask[i+w])?1:0;}return out;}
  function crossErode(mask,w,h){const out=new Uint8Array(mask.length);for(let y=1;y<h-1;y++)for(let x=1;x<w-1;x++){const i=y*w+x;out[i]=(mask[i]&&mask[i-1]&&mask[i+1]&&mask[i-w]&&mask[i+w])?1:0;}return out;}
  function morphDilate(mask,w,h,r){let out=new Uint8Array(mask);for(let k=0;k<r;k++)out=crossDilate(out,w,h);return out;}
  function morphErode(mask,w,h,r){let out=new Uint8Array(mask);for(let k=0;k<r;k++)out=crossErode(out,w,h);return out;}
  function morphOpen(mask,w,h,r){return morphDilate(morphErode(mask,w,h,r),w,h,r);}
  function morphClose(mask,w,h,r){return morphErode(morphDilate(mask,w,h,r),w,h,r);}
  function gridWireComponent(gray,w,h,pitchPx){if(!pitchPx)return null;let m=adaptiveDarkMask(gray,w,h,pitchPx);const openR=clamp(Math.round(pitchPx*.06),1,2),closeR=clamp(Math.round(pitchPx*.10),2,4);m=morphOpen(m,w,h,openR);m=morphClose(m,w,h,closeR);const comp=largestComponent(m,w,h,true);if(!comp)return null;return{comp,mask:m,threshold:null,invert:false,method:'10mm 격자선 제거 + 선재 추출'};}

  function largestComponent(mask,w,h,rejectFrame=false) {
    const seen=new Uint8Array(mask.length),q=new Int32Array(mask.length);let best=null;
    const dirs=[-1,1,-w,w,-w-1,-w+1,w-1,w+1];
    for(let i=0;i<mask.length;i++){
      if(!mask[i]||seen[i])continue;let qs=0,qe=0;q[qe++]=i;seen[i]=1;let area=0,minX=w,minY=h,maxX=0,maxY=0;const pix=[];
      while(qs<qe){const p=q[qs++],y=(p/w)|0,x=p-y*w;pix.push(p);area++;if(x<minX)minX=x;if(x>maxX)maxX=x;if(y<minY)minY=y;if(y>maxY)maxY=y;
        for(const dd of dirs){const n=p+dd;if(n<0||n>=mask.length||seen[n]||!mask[n])continue;const ny=(n/w)|0,nx=n-ny*w;if(Math.abs(nx-x)>1||Math.abs(ny-y)>1)continue;seen[n]=1;q[qe++]=n;}
      }
      const bw=maxX-minX+1,bh=maxY-minY+1,span=Math.max(bw,bh),small=Math.max(1,Math.min(bw,bh)),fill=area/(bw*bh),border=(minX<2||minY<2||maxX>w-3||maxY>h-3),elong=span/small;
      const spanRatio=Math.max(bw/w,bh/h),areaRatio=area/(w*h);
      if(rejectFrame && spanRatio>.76 && fill<.11)continue;
      let shapeFactor=1;
      if(fill<.012||fill>.68)shapeFactor*=.18;else if(fill<.025||fill>.48)shapeFactor*=.48;
      if(elong>14)shapeFactor*=.22;else if(elong>9)shapeFactor*=.55;
      if(spanRatio<.12||areaRatio<.0004)shapeFactor*=.25;
      if(border)shapeFactor*=.14;
      // S/J/U형 선재는 큰 영역을 차지하지만 bounding box 내부 충전율은 낮은 편이다.
      const score=Math.sqrt(area)*Math.pow(Math.max(.02,spanRatio),1.35)*shapeFactor*(1+Math.min(2.5,elong)*.12);
      if(!best||score>best.score)best={area,minX,minY,maxX,maxY,pix,score,fill,elong,border,spanRatio,areaRatio};
    }
    return best;
  }

  function processedComponent(gray,w,h,threshold,invert,pitchPx) {
    const raw=new Uint8Array(gray.length);
    for(let i=0;i<gray.length;i++)raw[i]=(invert?gray[i]>threshold:gray[i]<threshold)?1:0;
    const r=Math.max(1,Math.min(7,Math.round((pitchPx||40)*.07)));
    let m=densityFilter(raw,w,h,r,.37);m=erode(dilate(m,w,h),w,h);
    return {comp:largestComponent(m,w,h),mask:m};
  }

  function chooseComponent(imageData,gray,w,h,pitchPx) {
    const candidates=[],gw=gridWireComponent(gray,w,h,pitchPx);
    if(gw?.comp && gw.comp.spanRatio>.14 && gw.comp.fill>.018 && gw.comp.fill<.42)return gw;
    if(gw?.comp)candidates.push(gw);
    const bg=backgroundDifferenceMask(imageData,w,h,pitchPx),bgComp=largestComponent(bg.mask,w,h);if(bgComp)candidates.push({comp:bgComp,mask:bg.mask,threshold:null,invert:false,method:'배경색/명암 분리'});
    const t=otsu(gray);for(const [thr,invert] of [[clamp(Math.round(t*.88),30,220),false],[clamp(Math.round(t*1.10),30,225),true]]){const r=processedComponent(gray,w,h,thr,invert,pitchPx);if(r.comp)candidates.push({...r,threshold:thr,invert,method:'명암 보조'});}if(!candidates.length)return null;candidates.sort((a,b)=>b.comp.score-a.comp.score);return candidates[0];
  }

  function cropComponent(comp,w,h,pad=4){const x0=Math.max(0,comp.minX-pad),y0=Math.max(0,comp.minY-pad),x1=Math.min(w-1,comp.maxX+pad),y1=Math.min(h-1,comp.maxY+pad),cw=x1-x0+1,ch=y1-y0+1,m=new Uint8Array(cw*ch);for(const p of comp.pix){const y=(p/w)|0,x=p-y*w;m[(y-y0)*cw+(x-x0)]=1;}return{mask:m,w:cw,h:ch,x0,y0};}

  function skeletonize(input,w,h) {
    const a=new Uint8Array(input);let changed=true,iter=0,mark=new Uint8Array(a.length);
    const N=(x,y)=>[a[(y-1)*w+x],a[(y-1)*w+x+1],a[y*w+x+1],a[(y+1)*w+x+1],a[(y+1)*w+x],a[(y+1)*w+x-1],a[y*w+x-1],a[(y-1)*w+x-1]];
    while(changed&&iter++<120){changed=false;mark.fill(0);for(let pass=0;pass<2;pass++){
      for(let y=1;y<h-1;y++)for(let x=1;x<w-1;x++){const idx=y*w+x;if(!a[idx])continue;const p=N(x,y),B=p.reduce((s,v)=>s+v,0);if(B<2||B>6)continue;let A=0;for(let k=0;k<8;k++)if(p[k]===0&&p[(k+1)%8]===1)A++;if(A!==1)continue;if(pass===0){if(p[0]*p[2]*p[4]!==0||p[2]*p[4]*p[6]!==0)continue;}else{if(p[0]*p[2]*p[6]!==0||p[0]*p[4]*p[6]!==0)continue;}mark[idx]=1;}
      for(let i=0;i<a.length;i++)if(mark[i]){a[i]=0;changed=true;}mark.fill(0);
    }}return a;
  }

  class MinHeap{constructor(){this.a=[];}push(item){const a=this.a;a.push(item);let i=a.length-1;while(i){const p=(i-1)>>1;if(a[p][0]<=item[0])break;a[i]=a[p];i=p;}a[i]=item;}pop(){const a=this.a;if(!a.length)return null;const root=a[0],last=a.pop();if(a.length){let i=0;while(true){let l=i*2+1,r=l+1;if(l>=a.length)break;let c=r<a.length&&a[r][0]<a[l][0]?r:l;if(a[c][0]>=last[0])break;a[i]=a[c];i=c;}a[i]=last;}return root;}}

  function skeletonPath(sk,w,h){const nodes=[];for(let i=0;i<sk.length;i++)if(sk[i])nodes.push(i);if(nodes.length<2)return[];function degree(p){const y=(p/w)|0,x=p-y*w;let n=0;for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){if(!dx&&!dy)continue;const xx=x+dx,yy=y+dy;if(xx>=0&&xx<w&&yy>=0&&yy<h&&sk[yy*w+xx])n++;}return n;}const ends=nodes.filter(p=>degree(p)===1),seed=ends[0]||nodes[0];function dijkstra(start,needPrev=false){const dist=new Float64Array(sk.length);dist.fill(Infinity);const prev=needPrev?new Int32Array(sk.length):null;if(prev)prev.fill(-1);const heap=new MinHeap();dist[start]=0;heap.push([0,start]);let far=start,farD=0;while(heap.a.length){const [d,p]=heap.pop();if(d!==dist[p])continue;if(d>farD){farD=d;far=p;}const y=(p/w)|0,x=p-y*w;for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){if(!dx&&!dy)continue;const xx=x+dx,yy=y+dy;if(xx<0||xx>=w||yy<0||yy>=h)continue;const n=yy*w+xx;if(!sk[n])continue;const nd=d+((dx&&dy)?Math.SQRT2:1);if(nd<dist[n]){dist[n]=nd;if(prev)prev[n]=p;heap.push([nd,n]);}}}return{far,dist,prev};}const a=dijkstra(seed).far,bres=dijkstra(a,true),b=bres.far,path=[];let p=b,guard=0;while(p!==-1&&guard++<sk.length){const y=(p/w)|0,x=p-y*w;path.push({x,y});if(p===a)break;p=bres.prev[p];}path.reverse();return path;}
  function smoothPath(path,win=3){if(path.length<win*2+1)return path.slice();const out=[];for(let i=0;i<path.length;i++){let sx=0,sy=0,n=0;for(let k=Math.max(0,i-win);k<=Math.min(path.length-1,i+win);k++){sx+=path[k].x;sy+=path[k].y;n++;}out.push({x:sx/n,y:sy/n});}return out;}
  function decimatePath(path,minDist=2){if(path.length<3)return path;const out=[path[0]];let last=path[0];for(let i=1;i<path.length-1;i++){const p=path[i];if(Math.hypot(p.x-last.x,p.y-last.y)>=minDist){out.push(p);last=p;}}out.push(path[path.length-1]);return out;}
  function pathLength(path){let s=0;for(let i=1;i<path.length;i++)s+=Math.hypot(path[i].x-path[i-1].x,path[i].y-path[i-1].y);return s;}
  function median(a){if(!a.length)return NaN;const b=a.slice().sort((x,y)=>x-y),m=b.length>>1;return b.length%2?b[m]:(b[m-1]+b[m])/2;}
  function circleRadius(a,b,c){const A=Math.hypot(b.x-c.x,b.y-c.y),B=Math.hypot(a.x-c.x,a.y-c.y),C=Math.hypot(a.x-b.x,a.y-b.y),area2=Math.abs((b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x));if(area2<1e-5)return Infinity;return A*B*C/(2*area2);}
  function estimateRadii(path,mmPerPx,bbox,diameter){if(path.length<15)return{r1:NaN,r2:NaN};const sep=Math.max(3,Math.floor(path.length/45)),cy=(bbox.minY+bbox.maxY)/2,upper=[],lower=[];for(let i=sep;i<path.length-sep;i+=Math.max(1,Math.floor(sep/2))){const r=circleRadius(path[i-sep],path[i],path[i+sep])*mmPerPx;if(!Number.isFinite(r)||r<diameter*.55||r>Math.max((bbox.maxX-bbox.minX),(bbox.maxY-bbox.minY))*mmPerPx*1.8)continue;(path[i].y<cy?upper:lower).push(r);}return{r1:median(upper),r2:median(lower)};}

  function pathBBox(path){let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;for(const p of path){if(p.x<minX)minX=p.x;if(p.x>maxX)maxX=p.x;if(p.y<minY)minY=p.y;if(p.y>maxY)maxY=p.y;}return{minX,minY,maxX,maxY,w:Math.max(1,maxX-minX),h:Math.max(1,maxY-minY)};}
  function estimateWirePx(comp,path){
    const lenPx=Math.max(1,pathLength(path));
    const areaPx=Math.max(1,comp?.area||0);
    const bboxSpan=Math.max(1,Math.min(comp?.maxX-comp?.minX||1, comp?.maxY-comp?.minY||1));
    const raw=areaPx/lenPx;
    return clamp(raw, 2, Math.max(6, bboxSpan*.35));
  }

  function emergencyHookPath(widthPx=600,heightPx=1000) {
    const w=Math.max(120,widthPx), h=Math.max(180,heightPx);
    return [
      {x:w*.30,y:h*.22},{x:w*.28,y:h*.14},{x:w*.36,y:h*.08},{x:w*.48,y:h*.08},
      {x:w*.56,y:h*.14},{x:w*.57,y:h*.31},{x:w*.55,y:h*.56},{x:w*.60,y:h*.77},
      {x:w*.68,y:h*.88},{x:w*.77,y:h*.90},{x:w*.84,y:h*.84},{x:w*.86,y:h*.72}
    ];
  }

  async function makeEmergencyResult(item, reason='자동 인식 실패') {
    let iw=600, ih=1000;
    try {
      if(item.blob){ const ds=await blobToCanvas(item.blob); iw=ds.w; ih=ds.h; }
    } catch(_) {}
    const diameter=Math.max(.1,parseFloat(item.diameter)||6);
    const approxW=parseFloat(item.approxWidth), approxH=parseFloat(item.approxHeight);
    let width=Number.isFinite(approxW)&&approxW>0?approxW:Math.max(diameter*18,90);
    let height=Number.isFinite(approxH)&&approxH>0?approxH:Math.max(diameter*40,220);
    if(iw>ih && !Number.isFinite(approxW) && !Number.isFinite(approxH)){ const t=width;width=height;height=t; }
    let p=emergencyHookPath(iw,ih), pb=pathBBox(p);
    const sx=(width-diameter)/Math.max(1,pb.w), sy=(height-diameter)/Math.max(1,pb.h);
    p=p.map(q=>({x:(q.x-pb.minX)*sx,y:(q.y-pb.minY)*sy}));
    const length=pathLength(p);
    return {
      id:item.id,name:item.name.trim()||makeJigNumber(currentLineCode(),item.seq),material:item.material.trim()||'SUS304',diameter,
      baseWidth:width,baseHeight:height,baseLength:length,baseR1:NaN,baseR2:NaN,
      width,height,length,r1:NaN,r2:NaN,pathBase:p,path:p.map(q=>({...q})), rawPath:p.map(q=>({...q})), rawBBox:{minX:0,minY:0,maxX:width,maxY:height,w:width,h:height}, imageW:iw,imageH:ih,
      scaleSource:'자동 인식 실패 · 임시도면',scaleConfidence:.05,quality:.05,threshold:null,invert:false,
      segmentMethod:'임시 HOOK 형상',gridDetected:false,arDetected:false,gridReason:'',shapeFill:0,arDistanceMm:item.arDistanceMm||null,
      dimensionEstimated:true,shapeEstimated:true,warning:reason, photoDataUrl:item.photoDataUrl||'', captureType:item.captureType||'jig', manualDims:{}
    };
  }

  async function analyzeCapture(item) {
    if (!item.blob) throw new Error('촬영 원본이 없습니다. 새로 촬영하세요.');
    const ds=await blobToCanvas(item.blob),gray=grayArray(ds.imageData),grid=detectGrid(gray,ds.w,ds.h);
    const pitch=grid.pitch||Math.max(18,Math.min(ds.w,ds.h)/20);
    const seg=chooseComponent(ds.imageData,gray,ds.w,ds.h,grid.pitch||null);
    if(!seg?.comp||seg.comp.area<Math.max(70,ds.w*ds.h*.00035)) return await makeEmergencyResult(item,'치구 형상을 충분히 찾지 못해 임시 형상으로 생성했습니다.');
    const comp=seg.comp;
    const suspiciousShape=!!(comp.border||comp.fill>.62||comp.spanRatio<.14);
    const crop=cropComponent(comp,ds.w,ds.h,5),sk=skeletonize(crop.mask,crop.w,crop.h);
    let path=skeletonPath(sk,crop.w,crop.h);if(path.length<8)return await makeEmergencyResult(item,'중심선 추출이 불안정하여 임시 형상으로 생성했습니다.');
    path=path.map(p=>({x:p.x+crop.x0,y:p.y+crop.y0}));
    path=smoothPath(path,Math.max(1,Math.round(pitch*.012)));path=decimatePath(path,Math.max(1.2,pitch*.022));

    const pb=pathBBox(path),approxW=parseFloat(item.approxWidth),approxH=parseFloat(item.approxHeight),diameter=Math.max(.1,parseFloat(item.diameter)||6);
    const userScales=[];
    // 입력 폭/높이는 선재 외곽 전체치수로 간주하고, 중심선 span에서 Ø를 뺀 값으로 스케일을 구한다.
    if(Number.isFinite(approxW)&&approxW>diameter)userScales.push((approxW-diameter)/pb.w);
    if(Number.isFinite(approxH)&&approxH>diameter)userScales.push((approxH-diameter)/pb.h);
    let mmPerPx,scaleSource,scaleConfidence;
    const mode=item.measureMode||'auto', arScale=parseFloat(item.arMmPerPx);
    const wirePxEst=estimateWirePx(comp,path);
    const wireDerivedScale=Number.isFinite(wirePxEst)&&wirePxEst>0 ? diameter/wirePxEst : NaN;
    if(userScales.length){
      mmPerPx=userScales.reduce((a,b)=>a+b,0)/userScales.length;scaleSource='사용자 대략치수';scaleConfidence=.92;
    } else if(mode==='manual') {
      if(Number.isFinite(wireDerivedScale)&&wireDerivedScale>0){
        mmPerPx=wireDerivedScale;scaleSource='Ø 기반 자동 추정';scaleConfidence=.38;
      } else {
        mmPerPx=1;scaleSource='치수 미인식 · 임시치수';scaleConfidence=.12;
      }
    } else if(mode==='ar' && Number.isFinite(arScale) && arScale>0) {
      mmPerPx=arScale;scaleSource='AR 자동 측정';scaleConfidence=.68;
    } else if(mode==='grid' && grid.pitch) {
      mmPerPx=10/grid.pitch;scaleSource='1cm 격자 자동';scaleConfidence=grid.confidence;
    } else if(mode==='grid') {
      if(Number.isFinite(wireDerivedScale)&&wireDerivedScale>0){
        mmPerPx=wireDerivedScale;scaleSource='Ø 기반 자동 추정';scaleConfidence=.36;
      } else {
        mmPerPx=1;scaleSource='치수 미인식 · 임시치수';scaleConfidence=.12;
      }
    } else if(mode==='auto' && grid.pitch) {
      mmPerPx=10/grid.pitch;scaleSource='1cm 격자 자동';scaleConfidence=grid.confidence;
    } else if(Number.isFinite(arScale) && arScale>0) {
      mmPerPx=arScale;scaleSource='AR 자동 측정';scaleConfidence=.64;
    } else if(grid.pitch) {
      mmPerPx=10/grid.pitch;scaleSource='1cm 격자 자동';scaleConfidence=grid.confidence;
    } else if(Number.isFinite(wireDerivedScale)&&wireDerivedScale>0) {
      mmPerPx=wireDerivedScale;scaleSource='Ø 기반 자동 추정';scaleConfidence=.34;
    } else {
      mmPerPx=1;scaleSource='치수 미인식 · 임시치수';scaleConfidence=.10;
    }

    const width=pb.w*mmPerPx+diameter,height=pb.h*mmPerPx+diameter,length=pathLength(path)*mmPerPx;
    const r=estimateRadii(path,mmPerPx,pb,diameter);
    const pathMm=path.map(p=>({x:(p.x-pb.minX)*mmPerPx,y:(p.y-pb.minY)*mmPerPx}));
    const aspect=Math.max(width,height)/Math.max(1,Math.min(width,height)),curveRatio=length/Math.max(1,Math.hypot(width,height));
    let quality=scaleConfidence*.38+(comp.fill>=.025&&comp.fill<=.35?.22:.08)+(comp.border?0:.16)+(path.length>24?.14:.08)+(curveRatio>1.20?.10:.04)+(seg.method.includes('격자선 제거')?.08:0);
    quality=clamp(quality,.08,.99);
    return {
      id:item.id,name:item.name.trim()||makeJigNumber(currentLineCode(),item.seq),material:item.material.trim()||'SUS304',diameter,
      baseWidth:width,baseHeight:height,baseLength:length,baseR1:r.r1,baseR2:r.r2,
      width,height,length,r1:r.r1,r2:r.r2,pathBase:pathMm,path:pathMm.map(p=>({...p})), rawPath:path.map(p=>({...p})), rawBBox:pb, imageW:ds.w, imageH:ds.h,
      scaleSource,scaleConfidence,quality,threshold:seg.threshold,invert:seg.invert,segmentMethod:seg.method,
      gridDetected:!!grid.pitch,arDetected:scaleSource==='AR 자동 측정',gridReason:grid.reason||'',shapeFill:comp.fill,arDistanceMm:item.arDistanceMm||null,
      dimensionEstimated:scaleSource.includes('추정')||scaleSource.includes('임시'), wirePxEstimate:wirePxEst,
      shapeEstimated:suspiciousShape, warning:suspiciousShape?'배경/그림자 오인 가능성이 있어 형상 확인이 필요합니다.':'', photoDataUrl:item.photoDataUrl||'', captureType:item.captureType||'jig', manualDims:{}
    };
  }

  async function batchAnalyze() {
    if(!state.captures.length||state.working)return;
    state.working=true;updateShotUI();stopCamera();
    $('progressCard').classList.remove('hidden');$('progressCard').open=true;$('resultsSection').classList.add('hidden');$('resultsSection').open=false;
    state.results=[];setStatus('일괄 분석중','busy');
    const total=state.captures.length;
    for(let i=0;i<total;i++){
      const item=state.captures[i];
      $('progressText').textContent=`${i+1} / ${total} · ${item.name} 분석 중`;
      $('progressBar').style.width=`${Math.round((i/total)*100)}%`;
      await new Promise(r=>setTimeout(r,25));
      try{
        item.photoDataUrl = item.photoDataUrl || await blobToDataURL(item.blob).catch(()=> '');
        const result=await analyzeCapture(item);state.results.push({...result,ok:true});
        revokeCapture(item);
      }catch(err){
        try{item.photoDataUrl = item.photoDataUrl || await blobToDataURL(item.blob).catch(()=> ''); const fallback=await makeEmergencyResult(item,err?.message||String(err));state.results.push({...fallback,ok:true});revokeCapture(item);}catch(_){state.results.push({id:item.id,name:item.name,material:item.material,diameter:parseFloat(item.diameter)||6,ok:false,error:err?.message||String(err)});}
      }
    }
    $('progressBar').style.width='100%';$('progressText').textContent=`${total}장 처리 완료`;
    // Remove successfully analyzed photographs from the capture queue/DOM as well.
    state.captures = state.captures.filter(c => c.blob);
    renderCaptureList();
    persistUsedNumbers();state.working=false;updateShotUI();renderResults();$('resultsSection').classList.remove('hidden');$('resultsSection').open=true;
    $('resultsSection').scrollIntoView({behavior:'smooth',block:'start'});
    const ok=state.results.filter(r=>r.ok).length;
    setStatus(`${ok}/${total} 도면 생성`,ok===total?'ok':'warn');
    toast(`도면 ${ok}장 생성 완료`);
  }

  function transformedPath(r) {
    if(!r.ok)return[];
    const sx=(parseFloat(r.width)||r.baseWidth)/Math.max(.001,r.baseWidth),sy=(parseFloat(r.height)||r.baseHeight)/Math.max(.001,r.baseHeight);
    return r.pathBase.map(p=>({x:p.x*sx,y:p.y*sy}));
  }

  function recalcFromDimensions(r) {
    if(!r.ok)return;
    const p=transformedPath(r),avgScale=((parseFloat(r.width)||r.baseWidth)/r.baseWidth+(parseFloat(r.height)||r.baseHeight)/r.baseHeight)/2;
    r.path=p;r.length=pathLength(p);if(Number.isFinite(r.baseR1))r.r1=r.baseR1*avgScale;if(Number.isFinite(r.baseR2))r.r2=r.baseR2*avgScale;
  }

  function readDimValue(r,key,def){
    if(['width','height','length','r1','r2','diameter'].includes(key)) return Number.isFinite(parseFloat(r[key])) ? parseFloat(r[key]) : def;
    return Number.isFinite(parseFloat(r.manualDims?.[key])) ? parseFloat(r.manualDims[key]) : def;
  }
  function writeDimValue(r,key,val){
    if(['width','height','length','r1','r2','diameter'].includes(key)) r[key]=val;
    else { r.manualDims=r.manualDims||{}; r.manualDims[key]=val; }
  }
  function dist(a,b){return Math.hypot((b.x||0)-(a.x||0),(b.y||0)-(a.y||0));}
  function localRadius(path,idx){
    const s=Math.max(2,Math.floor(path.length/40));
    const i0=Math.max(0,idx-s), i2=Math.min(path.length-1,idx+s);
    return circleRadius(path[i0],path[idx],path[i2]);
  }
  function buildAnchorIndices(path){
    if(path.length<4) return [0,path.length-1];
    const step=Math.max(2,Math.floor(path.length/28)); const cand=[];
    for(let i=step;i<path.length-step;i++){
      const a=path[i-step],b=path[i],c=path[i+step];
      const v1x=b.x-a.x,v1y=b.y-a.y,v2x=c.x-b.x,v2y=c.y-b.y;
      const m1=Math.hypot(v1x,v1y),m2=Math.hypot(v2x,v2y); if(m1<1e-3||m2<1e-3) continue;
      const ang=Math.acos(clamp((v1x*v2x+v1y*v2y)/(m1*m2),-1,1))*180/Math.PI;
      if(ang>14) cand.push({i,ang});
    }
    const out=[0];
    for(const c of cand.sort((x,y)=>y.ang-x.ang)){
      if(out.some(v=>Math.abs(v-c.i)<step*2)) continue;
      out.push(c.i);
    }
    out.push(path.length-1);
    return [...new Set(out)].sort((a,b)=>a-b);
  }
  function rdpSimplify(points, epsilon){
    if(points.length<3) return points.slice();
    const first=points[0], last=points[points.length-1];
    const dx=last.x-first.x, dy=last.y-first.y, den=Math.max(1e-9,Math.hypot(dx,dy));
    let maxDist=-1, idx=-1;
    for(let i=1;i<points.length-1;i++){
      const p=points[i];
      const d=Math.abs(dy*p.x-dx*p.y+last.x*first.y-last.y*first.x)/den;
      if(d>maxDist){maxDist=d;idx=i;}
    }
    if(maxDist>epsilon){
      const left=rdpSimplify(points.slice(0,idx+1),epsilon), right=rdpSimplify(points.slice(idx),epsilon);
      return left.slice(0,-1).concat(right);
    }
    return [first,last];
  }
  function snapAngleDeg(deg,tol=7){
    const targets=[0,15,30,45,60,75,90,105,120,135,150,165,180,-15,-30,-45,-60,-75,-90,-105,-120,-135,-150,-165,-180];
    let best=deg,bd=999;
    for(const t of targets){const d=Math.abs((((deg-t)+180)%360)-180);if(d<bd){bd=d;best=t;}}
    return bd<=tol?best:deg;
  }
  function extremaIndices(path){
    if(!path.length) return [];
    let minX=0,maxX=0,minY=0,maxY=0;
    for(let i=1;i<path.length;i++){
      if(path[i].x<path[minX].x) minX=i;
      if(path[i].x>path[maxX].x) maxX=i;
      if(path[i].y<path[minY].y) minY=i;
      if(path[i].y>path[maxY].y) maxY=i;
    }
    return [minX,maxX,minY,maxY];
  }
  function fidelityPath(path){
    if(path.length<3) return path.slice();
    const pb=pathBounds(path);
    const sm=smoothPath(path, Math.max(1, Math.round(Math.min(pb.w,pb.h)*0.004)));
    return decimatePath(sm, Math.max(1.2, Math.min(pb.w,pb.h)*0.006));
  }
  function simplifyAnchors(path){
    if(path.length<3) return path.slice();
    const lvl=currentStraightenLevel();
    const base=buildAnchorIndices(path);
    const ext=extremaIndices(path);
    const stride=lvl==='medium'?Math.max(10,Math.floor(path.length/7)):lvl==='max'?Math.max(6,Math.floor(path.length/12)):Math.max(8,Math.floor(path.length/9));
    const ptsIdx=[0,path.length-1,...base,...ext];
    for(let i=stride;i<path.length-1;i+=stride) ptsIdx.push(i);
    const uniq=[...new Set(ptsIdx)].sort((a,b)=>a-b);
    const minGap=lvl==='max'?2:lvl==='medium'?8:5;
    const keep=[];
    for(const i of uniq){
      if(!keep.length || i-keep[keep.length-1]>=minGap || i===path.length-1) keep.push(i);
      else {
        const prev=keep[keep.length-1];
        const pi=path[i], pp=path[prev];
        if(Math.hypot(pi.x-pp.x,pi.y-pp.y)>minGap*1.5) keep.push(i);
      }
    }
    return keep.map(i=>({...path[i]}));
  }
  function straightenPath(path){
    const raw=fidelityPath(path);
    const pts=simplifyAnchors(raw);
    if(pts.length<2) return raw;
    const lvl=currentStraightenLevel();
    const tol=lvl==='medium'?3:lvl==='max'?10:7;
    const out=[{...pts[0]}];
    for(let i=1;i<pts.length;i++){
      const prev=out[out.length-1],src=pts[i];
      const dx=src.x-prev.x,dy=src.y-prev.y,len=Math.hypot(dx,dy);
      if(len<1) continue;
      const deg=Math.atan2(dy,dx)*180/Math.PI;
      const snapped=snapAngleDeg(deg,tol);
      const useSnap=Math.abs(snapped-deg)>1e-6;
      const rad=(useSnap?snapped:deg)*Math.PI/180;
      let nx=prev.x+Math.cos(rad)*len, ny=prev.y+Math.sin(rad)*len;
      if(i===pts.length-1 && Math.hypot(nx-src.x,ny-src.y)>len*.15){nx=src.x;ny=src.y;}
      out.push({x:nx,y:ny});
    }
    const rb=pathBounds(raw), ob=pathBounds(out), rawLen=pathLength(raw), outLen=pathLength(out);
    if(out.length<5 && raw.length>=5) return raw;
    if(outLen<rawLen*0.60 || outLen>rawLen*1.28 || ob.w<rb.w*0.68 || ob.h<rb.h*0.68) return raw;
    return out;
  }
  function cornerArcData(path){
    const out=[];
    for(let i=1;i<path.length-1;i++){
      const a=path[i-1],b=path[i],c=path[i+1],ab=dist(a,b),bc=dist(b,c);
      if(ab<3||bc<3) continue;
      const v1={x:(a.x-b.x)/ab,y:(a.y-b.y)/ab},v2={x:(c.x-b.x)/bc,y:(c.y-b.y)/bc};
      const theta=Math.acos(clamp(v1.x*v2.x+v1.y*v2.y,-1,1));
      if(theta<0.18||theta>2.95) continue;
      const t=Math.min(ab,bc)*0.22;
      const p1={x:b.x+v1.x*t,y:b.y+v1.y*t},p2={x:b.x+v2.x*t,y:b.y+v2.y*t};
      const r=t/Math.tan(theta/2);
      out.push({i,p1,p2,r,corner:b});
    }
    return out;
  }
  function buildCadPath(path, scale=1){
    const pts=straightenPath(path); if(pts.length<2) return {points:pts,d:'',arcs:[]};
    const arcs=cornerArcData(pts), amap=new Map(arcs.map(a=>[a.i,a]));
    let d=`M ${pts[0].x*scale} ${pts[0].y*scale}`;
    for(let i=1;i<pts.length;i++){
      const a=amap.get(i);
      if(a){
        d+=` L ${a.p1.x*scale} ${a.p1.y*scale}`;
        const prev=pts[i-1],next=pts[i+1];
        const cross=(pts[i].x-prev.x)*(next.y-pts[i].y)-(pts[i].y-prev.y)*(next.x-pts[i].x);
        const sweep=cross>0?1:0;
        d+=` A ${Math.max(1,a.r*scale)} ${Math.max(1,a.r*scale)} 0 0 ${sweep} ${a.p2.x*scale} ${a.p2.y*scale}`;
      } else d+=` L ${pts[i].x*scale} ${pts[i].y*scale}`;
    }
    return {points:pts,d,arcs};
  }
  function pathBounds(path){
    let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
    for(const p of path){minX=Math.min(minX,p.x);minY=Math.min(minY,p.y);maxX=Math.max(maxX,p.x);maxY=Math.max(maxY,p.y);}
    return {minX,minY,maxX,maxY,w:Math.max(1,maxX-minX),h:Math.max(1,maxY-minY)};
  }
  function fitRect(srcW,srcH,box){
    const sc=Math.min(box.w/srcW, box.h/srcH);
    const w=srcW*sc,h=srcH*sc; return {x:box.x+(box.w-w)/2,y:box.y+(box.h-h)/2,w,h,scale:sc};
  }
  function escAttr(v){return String(v??'').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;');}
  function layoutDimensionLabels(specs,W,H){
    const placed=[];
    return specs.map((s,idx)=>{
      const lbl=(s.prefix||'')+n1(s.value);
      const w=Math.max(50,lbl.length*8+14), h=24;
      let tx=s.textX, ty=s.textY;
      for(let t=0;t<14;t++){
        const box={x:tx-w/2,y:ty-h/2,w,h};
        const hit=placed.some(p=>!(box.x+box.w<p.x || p.x+p.w<box.x || box.y+box.h<p.y || p.y+p.h<box.y));
        if(!hit && box.x>10 && box.y>10 && box.x+box.w<W-10 && box.y+box.h<H-10) break;
        tx=clamp(tx + (t%2===0?18:-12) + (idx%2===0?6:-6), w/2+10, W-w/2-10);
        ty=clamp(ty + 18, h/2+10, H-h/2-10);
      }
      placed.push({x:tx-w/2,y:ty-h/2,w,h});
      return {...s,textX:tx,textY:ty};
    });
  }
  function placeDimBox(x,y,w,h,used,W,H){
    const tries=[[0,0],[0,-30],[0,30],[34,0],[-34,0],[48,-28],[-48,-28],[48,28],[-48,28],[0,-58],[0,58]];
    for(const [dx,dy] of tries){
      const bx=clamp(x+dx,w/2+6,W-w/2-6),by=clamp(y+dy,h/2+6,H-h/2-6);
      const rect={x1:bx-w/2,y1:by-h/2,x2:bx+w/2,y2:by+h/2};
      const hit=used.some(r=>!(rect.x2<r.x1||rect.x1>r.x2||rect.y2<r.y1||rect.y1>r.y2));
      if(!hit){used.push(rect);return {x:bx,y:by};}
    }
    return {x:clamp(x,w/2+6,W-w/2-6),y:clamp(y,h/2+6,H-h/2-6)};
  }
  function buildDimensionSpecs(pathMm, pathScreen, W, H){
    const specs=[];
    if(pathScreen.length<2) return specs;
    const b=pathBounds(pathScreen);
    const left=pathScreen.reduce((a,p)=>p.x<a.x?p:a,pathScreen[0]);
    const right=pathScreen.reduce((a,p)=>p.x>a.x?p:a,pathScreen[0]);
    const top=pathScreen.reduce((a,p)=>p.y<a.y?p:a,pathScreen[0]);
    const bottom=pathScreen.reduce((a,p)=>p.y>a.y?p:a,pathScreen[0]);
    const widthVal=pathBounds(pathMm).w, heightVal=pathBounds(pathMm).h;
    const widthY=Math.max(42,b.minY-36), heightX=Math.max(42,b.minX-48);
    specs.push({key:'width', value:widthVal, kind:'overallH', textX:(left.x+right.x)/2, textY:widthY-12, x1:left.x, y1:widthY, x2:right.x, y2:widthY, ext:[[left.x,left.y,left.x,widthY],[right.x,right.y,right.x,widthY]]});
    specs.push({key:'height', value:heightVal, kind:'overallV', textX:heightX-10, textY:(top.y+bottom.y)/2, x1:heightX, y1:top.y, x2:heightX, y2:bottom.y, ext:[[top.x,top.y,heightX,top.y],[bottom.x,bottom.y,heightX,bottom.y]]});
    const minLen=6;
    let segNo=1,bendNo=1;
    const count=Math.min(pathMm.length, pathScreen.length);
    for(let i=0;i<count-1;i++){
      const p1=pathMm[i], p2=pathMm[i+1], s1=pathScreen[i], s2=pathScreen[i+1];
      const len=dist(p1,p2); if(len<minLen) continue;
      const dx=s2.x-s1.x, dy=s2.y-s1.y, mag=Math.max(1,Math.hypot(dx,dy));
      const nx=-dy/mag, ny=dx/mag, off=26+(i%4)*16;
      const d1={x:s1.x+nx*off,y:s1.y+ny*off}, d2={x:s2.x+nx*off,y:s2.y+ny*off};
      specs.push({key:`seg${segNo++}`, value:len, kind:'segment', textX:clamp((d1.x+d2.x)/2 + nx*10,56,W-56), textY:clamp((d1.y+d2.y)/2 + ny*10,40,H-40), x1:d1.x,y1:d1.y,x2:d2.x,y2:d2.y, ext:[[s1.x,s1.y,d1.x,d1.y],[s2.x,s2.y,d2.x,d2.y]]});
    }
    const bendCount=Math.min(pathMm.length, pathScreen.length);
    for(let i=1;i<bendCount-1;i++){
      const rmm=localRadius(pathMm,i); if(!(Number.isFinite(rmm)&&rmm>0.5)) continue;
      const p=pathScreen[i], dirX=(i<pathScreen.length-1?pathScreen[i+1].x-p.x:0)+(i>0?p.x-pathScreen[i-1].x:0), dirY=(i<pathScreen.length-1?pathScreen[i+1].y-p.y:0)+(i>0?p.y-pathScreen[i-1].y:0);
      const mag=Math.max(1,Math.hypot(dirX,dirY)), nx=-dirY/mag, ny=dirX/mag;
      const tx=clamp(p.x+nx*(48+(i%2)*18),56,W-56), ty=clamp(p.y+ny*(48+(i%2)*18),40,H-40);
      specs.push({key:`bendR${bendNo++}`, value:rmm, kind:'leader', prefix:'R', textX:tx, textY:ty, x1:p.x,y1:p.y,x2:tx-12,y2:ty});
    }
    return layoutDimensionLabels(specs,W,H);
  }
  function makeDimSvg(specs,r,forExport){
    const parts=['<defs><marker id="arr" markerWidth="8" markerHeight="8" refX="4" refY="4" orient="auto-start-reverse"><path d="M8,4 L1,1 L1,7 Z" fill="#111"/></marker></defs>'];
    for(const s of specs){
      const ext=(s.ext||[]).map(e=>`<line class="dim-line" x1="${e[0].toFixed(1)}" y1="${e[1].toFixed(1)}" x2="${e[2].toFixed(1)}" y2="${e[3].toFixed(1)}"/>`).join('');
      const main=`<line class="dim-line" marker-start="url(#arr)" marker-end="url(#arr)" x1="${s.x1.toFixed(1)}" y1="${s.y1.toFixed(1)}" x2="${s.x2.toFixed(1)}" y2="${s.y2.toFixed(1)}"/>`;
      const val=readDimValue(r,s.key,s.value), label=(s.prefix||'')+n1(val);
      const w=Math.max(50,label.length*8+14), h=24, bx=s.textX-w/2, by=s.textY-h/2;
      parts.push(`<g>${ext}${main}<rect class="dim-box" x="${bx.toFixed(1)}" y="${by.toFixed(1)}" rx="3" ry="3" width="${w.toFixed(1)}" height="${h}"/><text class="dim-text" x="${s.textX.toFixed(1)}" y="${(s.textY+4).toFixed(1)}" text-anchor="middle">${esc(label)}</text></g>`);
    }
    return parts.join('');
  }
  function buildSvgOnly(r){
    const W=1189,H=841, draw={x:95,y:90,w:760,h:610}, title={x:875,y:88,w:230,h:665};
    const variant = r.captureType==='product' ? 'photo' : currentRenderMode();
    const mmRaw=transformedPath(r);
    const mmForDrawing=straightenPath(mmRaw);
    const mmForDims=mmForDrawing;
    const date=new Date().toLocaleDateString('sv-SE');
    const width=parseFloat(r.width)||r.baseWidth, height=parseFloat(r.height)||r.baseHeight, length=parseFloat(r.length)||pathLength(mmRaw);
    let screen=[], shapeMarkup='', photoInset='';
    if(variant==='photo'){
      const fit=fitRect(r.imageW||1000, r.imageH||1000, draw);
      const raw=r.rawPath&&r.rawPath.length?r.rawPath:mmRaw;
      const rawBounds=pathBounds(raw);
      const fit2=fitRect(rawBounds.w||1, rawBounds.h||1, {x:fit.x,y:fit.y,w:fit.w,h:fit.h});
      const rawScreen=raw.map(p=>({x:fit2.x+(p.x-rawBounds.minX)*fit2.scale,y:fit2.y+(p.y-rawBounds.minY)*fit2.scale}));
      screen=straightenPath(rawScreen);
      shapeMarkup=`<rect x="${draw.x}" y="${draw.y}" width="${draw.w}" height="${draw.h}" fill="none" stroke="#bbb"/>${r.photoDataUrl?`<image href="${r.photoDataUrl}" x="${fit.x}" y="${fit.y}" width="${fit.w}" height="${fit.h}" preserveAspectRatio="xMidYMid meet"/>`:''}<polyline points="${rawScreen.map(p=>`${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')}" fill="none" stroke="rgba(0,0,0,.12)" stroke-width="2"/><polyline points="${screen.map(p=>`${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')}" fill="none" stroke="rgba(17,17,17,.45)" stroke-width="3"/>`;
    } else {
      const pb=pathBounds(mmForDrawing), sc=Math.min(draw.w/pb.w, draw.h/pb.h)*0.82, ox=draw.x+(draw.w-pb.w*sc)/2, oy=draw.y+(draw.h-pb.h*sc)/2;
      screen=mmForDrawing.map(p=>({x:ox+(p.x-pb.minX)*sc,y:oy+(p.y-pb.minY)*sc}));
      const centerPts=screen.map(p=>`${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
      const wirePx=clamp((parseFloat(r.diameter)||6)*sc,4,24);
      photoInset = r.photoDataUrl ? `<rect x="75" y="575" width="145" height="205" fill="none" stroke="#888"/><image href="${r.photoDataUrl}" x="78" y="578" width="139" height="199" preserveAspectRatio="xMidYMid meet"/>` : '';
      shapeMarkup=`<polyline points="${centerPts}" fill="none" stroke="#111" stroke-width="${wirePx.toFixed(1)}" stroke-linecap="round" stroke-linejoin="round"/><polyline points="${centerPts}" class="light-guide" fill="none"/>${photoInset}`;
    }
    const specs=buildDimensionSpecs(mmForDims,screen,W,H);
    const dimSvg=makeDimSvg(specs,r,true);
    const sideTitle = r.captureType==='product' ? '제품 사진 치수도' : (variant==='photo' ? '치구 사진 치수도' : '치구 자동도면');
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}"><rect width="${W}" height="${H}" fill="#fff"/><rect x="28" y="28" width="1133" height="785" fill="none" stroke="#111" stroke-width="1.4"/><text x="85" y="58" font-size="13" font-family="Arial,'Noto Sans KR',sans-serif" font-weight="700">3. 도면 (치수표기)</text><text x="85" y="82" font-size="12" font-family="Arial,'Noto Sans KR',sans-serif">※ 치수 단위 : mm / 재질 : ${esc(r.material)} / 환봉 Ø${n1(r.diameter)}</text>${shapeMarkup}${dimSvg}<rect x="${title.x}" y="${title.y}" width="${title.w}" height="${title.h}" fill="none" stroke="#111"/><text x="${title.x+14}" y="${title.y+24}" font-size="14" font-family="Arial,'Noto Sans KR',sans-serif" font-weight="700">${sideTitle}</text><text x="${title.x+14}" y="${title.y+54}" font-size="12" font-family="Arial,'Noto Sans KR',sans-serif">NO : ${esc(r.name)}</text><text x="${title.x+14}" y="${title.y+78}" font-size="12" font-family="Arial,'Noto Sans KR',sans-serif">재질 : ${esc(r.material)}</text><text x="${title.x+14}" y="${title.y+102}" font-size="12" font-family="Arial,'Noto Sans KR',sans-serif">Ø : ${n1(r.diameter)}</text><text x="${title.x+14}" y="${title.y+126}" font-size="12" font-family="Arial,'Noto Sans KR',sans-serif">전체 높이 : ${n1(height)}</text><text x="${title.x+14}" y="${title.y+150}" font-size="12" font-family="Arial,'Noto Sans KR',sans-serif">전체 폭 : ${n1(width)}</text><text x="${title.x+14}" y="${title.y+174}" font-size="12" font-family="Arial,'Noto Sans KR',sans-serif">전개길이 : ${n1(length)}</text><text x="${title.x+14}" y="${title.y+198}" font-size="12" font-family="Arial,'Noto Sans KR',sans-serif">작성일 : ${date}</text><text x="${title.x+14}" y="${title.y+222}" font-size="11" font-family="Arial,'Noto Sans KR',sans-serif">곡선 R : 중심선 기준</text>${variant==='drawing'?`<text x="${title.x+14}" y="${title.y+230}" font-size="11" font-family="Arial,'Noto Sans KR',sans-serif">실제 사진은 좌하단 참고</text>`:''}</svg>`;
  }
  function makeFigureHtml(r){
    const svg=buildSvgOnly(r);
    const variant = r.captureType==='product' ? 'photo' : currentRenderMode();
    const W=1189,H=841, draw={x:95,y:90,w:760,h:610};
    const mmPath = variant==='drawing' ? straightenPath(transformedPath(r)) : (r.rawPath&&r.rawPath.length?r.rawPath:transformedPath(r));
    let screen=[];
    if(variant==='photo'){
      const fit=fitRect(r.imageW||1000, r.imageH||1000, draw); const pb=pathBounds(mmPath); const fit2=fitRect(pb.w||1,pb.h||1,{x:fit.x,y:fit.y,w:fit.w,h:fit.h});
      screen=mmPath.map(p=>({x:fit2.x+(p.x-pb.minX)*fit2.scale,y:fit2.y+(p.y-pb.minY)*fit2.scale}));
    } else {
      const pb=pathBounds(mmPath), sc=Math.min(draw.w/pb.w, draw.h/pb.h)*0.82, ox=draw.x+(draw.w-pb.w*sc)/2, oy=draw.y+(draw.h-pb.h*sc)/2;
      screen=mmPath.map(p=>({x:ox+(p.x-pb.minX)*sc,y:oy+(p.y-pb.minY)*sc}));
    }
    const specs=buildDimensionSpecs(variant==='drawing'?mmPath:transformedPath(r),screen,W,H);
    const inputs = specs.map(s=>`<input class="dim-input-overlay" data-id="${escAttr(r.id)}" data-dimkey="${escAttr(s.key)}" type="number" step="0.1" value="${escAttr(n1(readDimValue(r,s.key,s.value)))}" style="left:${(s.textX/W*100).toFixed(2)}%;top:${(s.textY/H*100).toFixed(2)}%;" title="${escAttr(s.key)}">`).join('');
    return `<div class="figure-frame ${variant==='photo'?'photo-variant':''}">${svg}${inputs}</div>`;
  }

  function renderResults() {
    const host=$('resultList');
    if(!state.results.length){host.innerHTML='<div class="empty-state">생성된 도면이 없습니다.</div>';return;}
    host.innerHTML=state.results.map((r,i)=>{
      if(!r.ok)return `<div class="result-item failed" data-id="${r.id}"><div class="result-head"><b>${i+1}. ${esc(r.name)}</b><span class="source-badge quality bad">생성 실패</span></div><div class="result-msg">${esc(r.error)}</div></div>`;
      const quality=r.quality>.76?'양호':r.quality>.53?'보통':'확인필요';
      const modeText=(r.captureType==='product')?'제품 실제사진':'치구 '+(currentRenderMode()==='photo'?'실제사진':'도면');
      return `<div class="result-item" data-id="${r.id}"><div class="result-head"><b>${i+1}. ${esc(r.name)}</b><span class="source-badge ${r.arDetected?'ar ':''}${r.quality<.53?'quality bad':''}">${esc(modeText)} · ${quality}</span></div>${makeFigureHtml(r)}<div class="edit-grid"><label>전체 폭 mm<input data-rfield="width" type="number" step="0.1" value="${n1(r.width)}"></label><label>전체 높이 mm<input data-rfield="height" type="number" step="0.1" value="${n1(r.height)}"></label><label>전개길이 mm<input data-rfield="length" type="number" step="0.1" value="${n1(r.length)}"></label><label>상부 R mm<input data-rfield="r1" type="number" step="0.1" value="${n1(r.r1)}"></label><label>하부 R mm<input data-rfield="r2" type="number" step="0.1" value="${n1(r.r2)}"></label><label>Ø mm<input data-rfield="diameter" type="number" step="0.1" value="${n1(r.diameter)}"></label></div><div class="result-actions"><button class="btn apply-dims" data-id="${r.id}">폭/높이 형상 반영</button><button class="btn export-one" data-id="${r.id}">이 도면 PDF</button></div><div class="result-msg">형상 인식: ${esc(r.segmentMethod||'자동')} · 측정: ${esc(r.scaleSource)} · 도면은 ${esc(straightenLevelLabel(currentStraightenLevel()))} 직선화 보정이 적용되며, 꺾임부와 전체 치수선은 모두 직접 수정 가능합니다.${r.warning?` · ${esc(r.warning)}`:''}</div></div>`;
    }).join('');
  }

  $('resultList').addEventListener('input',e=>{
    const row=e.target.closest('.result-item'),r=state.results.find(x=>x.id===row?.dataset.id);if(!r?.ok)return;
    const f=e.target.dataset?.rfield,dk=e.target.dataset?.dimkey;const v=parseFloat(e.target.value);
    if(f && Number.isFinite(v)) r[f]=v;
    if(dk && Number.isFinite(v)) writeDimValue(r,dk,v);
    const fig=row.querySelector('.figure-frame');if(fig) fig.outerHTML=makeFigureHtml(r);
  });

  $('resultList').addEventListener('click',async e=>{
    const apply=e.target.closest('.apply-dims'),one=e.target.closest('.export-one');
    if(apply){const r=state.results.find(x=>x.id===apply.dataset.id);if(!r?.ok)return;recalcFromDimensions(r);renderResults();toast('폭/높이를 형상에 반영했습니다.');}
    if(one){const r=state.results.find(x=>x.id===one.dataset.id);if(r?.ok)await exportPdf([r],`${safeName(r.name)}_drawing.pdf`);}
  });

  // ---------------- Export ----------------
  function textBytes(s){return new TextEncoder().encode(s);}
  function concatBytes(parts){let n=0;for(const p of parts)n+=p.length;const out=new Uint8Array(n);let o=0;for(const p of parts){out.set(p,o);o+=p.length;}return out;}
  function base64ToBytes(b64){const bin=atob(b64),u=new Uint8Array(bin.length);for(let i=0;i<bin.length;i++)u[i]=bin.charCodeAt(i);return u;}

  async function svgToJpeg(svg) {
    const url='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(svg);
    const img=await new Promise((resolve,reject)=>{const im=new Image();im.onload=()=>resolve(im);im.onerror=()=>reject(new Error('도면 이미지 변환 실패'));im.src=url;});
    const c=document.createElement('canvas');c.width=1680;c.height=1185;const cx=c.getContext('2d');cx.fillStyle='white';cx.fillRect(0,0,c.width,c.height);cx.drawImage(img,0,0,c.width,c.height);
    const data=c.toDataURL('image/jpeg',.91).split(',')[1];return {bytes:base64ToBytes(data),w:c.width,h:c.height};
  }

  async function makePdf(results) {
    const imgs=[];for(const r of results)imgs.push(await svgToJpeg(buildSvgOnly(r)));
    const objectCount=2+results.length*3,objects=new Array(objectCount+1);
    objects[1]=textBytes('<< /Type /Catalog /Pages 2 0 R >>');
    const kids=[];for(let i=0;i<results.length;i++)kids.push(`${5+i*3} 0 R`);
    objects[2]=textBytes(`<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${results.length} >>`);
    for(let i=0;i<results.length;i++){
      const imNo=3+i*3,ctNo=4+i*3,pgNo=5+i*3,img=imgs[i];
      objects[imNo]=concatBytes([textBytes(`<< /Type /XObject /Subtype /Image /Width ${img.w} /Height ${img.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${img.bytes.length} >>\nstream\n`),img.bytes,textBytes('\nendstream')]);
      const content='q\n842 0 0 595 0 0 cm\n/Im0 Do\nQ\n';
      objects[ctNo]=textBytes(`<< /Length ${content.length} >>\nstream\n${content}endstream`);
      objects[pgNo]=textBytes(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 842 595] /Resources << /XObject << /Im0 ${imNo} 0 R >> >> /Contents ${ctNo} 0 R >>`);
    }
    const parts=[textBytes('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n')],offsets=new Array(objectCount+1).fill(0);let pos=parts[0].length;
    for(let i=1;i<=objectCount;i++){offsets[i]=pos;const block=concatBytes([textBytes(`${i} 0 obj\n`),objects[i],textBytes('\nendobj\n')]);parts.push(block);pos+=block.length;}
    const xrefPos=pos;let xref=`xref\n0 ${objectCount+1}\n0000000000 65535 f \n`;for(let i=1;i<=objectCount;i++)xref+=`${String(offsets[i]).padStart(10,'0')} 00000 n \n`;
    xref+=`trailer\n<< /Size ${objectCount+1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF`;
    parts.push(textBytes(xref));return new Blob(parts,{type:'application/pdf'});
  }

  function makeBatchDxf(results) {
    const lines=[],add=(...a)=>lines.push(...a.map(String));add('0','SECTION','2','HEADER','9','$ACADVER','1','AC1009','0','ENDSEC','0','SECTION','2','ENTITIES');
    let offsetX=0;
    for(const r of results){const path=transformedPath(r),maxY=Math.max(...path.map(p=>p.y));add('0','POLYLINE','8','CENTER','66','1','70','0');for(const p of path)add('0','VERTEX','8','CENTER','10',(p.x+offsetX).toFixed(4),'20',(maxY-p.y).toFixed(4),'30','0');add('0','SEQEND','8','CENTER');
      const width=parseFloat(r.width)||r.baseWidth,height=parseFloat(r.height)||r.baseHeight,length=parseFloat(r.length)||pathLength(path),tx=offsetX+Math.max(width,100)+15,ty=Math.max(height,100);
      const text=(x,y,h,t)=>add('0','TEXT','8','TEXT','10',x.toFixed(3),'20',y.toFixed(3),'30','0','40',h,'1',t);
      text(tx,ty,5,ascii(r.name));text(tx,ty-10,4,`MATERIAL ${ascii(r.material)}`);text(tx,ty-20,4,`WIRE DIA ${n1(r.diameter)} mm`);text(tx,ty-30,4,`WIDTH ${n1(width)} mm`);text(tx,ty-40,4,`HEIGHT ${n1(height)} mm`);text(tx,ty-50,4,`DEVELOPED ${n1(length)} mm`);text(tx,ty-60,4,`MEASURE ${ascii(r.scaleSource)}`);if(Number.isFinite(parseFloat(r.r1)))text(tx,ty-70,4,`R1 ~ ${n1(parseFloat(r.r1))} mm`);if(Number.isFinite(parseFloat(r.r2)))text(tx,ty-80,4,`R2 ~ ${n1(parseFloat(r.r2))} mm`);
      offsetX+=Math.max(width+170,280);
    }
    add('0','ENDSEC','0','EOF');return lines.join('\r\n');
  }

  async function shareOrDownload(blob,name) {
    const file=new File([blob],name,{type:blob.type||'application/octet-stream'});
    if(navigator.share && navigator.canShare?.({files:[file]})){
      try{await navigator.share({files:[file],title:name});return;}catch(err){if(err?.name==='AbortError')return;}
    }
    const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),2500);
  }

  async function exportPdf(results,name='HOOK_batch_drawings.pdf') {
    if(!results.length)return;setStatus('PDF 생성중','busy');try{const pdf=await makePdf(results);await shareOrDownload(pdf,name);setStatus('PDF 생성 완료','ok');}catch(err){setStatus('PDF 실패','warn');alert(`PDF 생성 실패: ${err?.message||err}`);}
  }

  async function exportDxf() {
    const ok=state.results.filter(r=>r.ok);if(!ok.length)return;const text=makeBatchDxf(ok),blob=new Blob([text],{type:'application/dxf;charset=utf-8'});await shareOrDownload(blob,'HOOK_batch_drawings.dxf');
  }

  function newJob() {
    if(!confirm('현재 도면과 촬영 정보를 모두 지우고 새 촬영을 시작할까요?'))return;
    persistUsedNumbers();clearCaptures();state.results=[];$('resultsSection').classList.add('hidden');$('resultsSection').open=false;$('progressCard').classList.add('hidden');$('progressCard').open=false;$('progressBar').style.width='0';state.seq=1;suggestNextStart();renderResults();setStatus('새 작업');window.scrollTo({top:0,behavior:'smooth'});
  }

  // ---------------- PWA install ----------------
  window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();state.deferredInstall=e;$('installBtn').classList.remove('hidden');});
  $('installBtn').addEventListener('click',async()=>{if(!state.deferredInstall)return;state.deferredInstall.prompt();await state.deferredInstall.userChoice;state.deferredInstall=null;$('installBtn').classList.add('hidden');});

  // ---------------- Events ----------------
  $('startCameraBtn').addEventListener('click',startCamera);
  $('stopCameraBtn').addEventListener('click',()=>{stopCamera();setStatus('카메라 꺼짐');});
  $('captureBtn').addEventListener('click',captureShot);
  $('uploadPhotoBtn').addEventListener('click',()=>$('filePicker').click());
  $('filePicker').addEventListener('change',async e=>{
    const files=[...(e.target.files||[])].filter(f=>String(f.type||'').startsWith('image/'));
    for(const f of files){ if(state.captures.length >= (parseInt($('maxShots').value,10)||30)) break; await addCaptureBlob(f,'upload',f.name); }
    if(files.length) toast(`${files.length}장 첨부 완료`);
    e.target.value='';
  });
  $('tabJigBtn').addEventListener('click',()=>setAppMode('jig'));
  $('tabProductBtn').addEventListener('click',()=>setAppMode('product'));
  $('renderModeSelect').addEventListener('change',e=>{setRenderModeValue(e.target.value);renderResults();});
  $('quickRenderModeSelect').addEventListener('change',e=>{setRenderModeValue(e.target.value);renderResults();});
  $('straightenLevelSelect').addEventListener('change',()=>renderResults());
  $('clearShotsBtn').addEventListener('click',()=>{if(confirm('촬영한 사진을 모두 삭제할까요?'))clearCaptures();});
  $('batchAnalyzeBtn').addEventListener('click',batchAnalyze);
  $('exportPdfBtn').addEventListener('click',()=>exportPdf(state.results.filter(r=>r.ok),'HOOK_batch_drawings.pdf'));
  $('exportDxfBtn').addEventListener('click',exportDxf);
  $('newJobBtn').addEventListener('click',newJob);
  $('arMeasureBtn').addEventListener('click',startArAutoMeasure);
  $('addLineCodeBtn').addEventListener('click',addLineCode);
  $('deleteLineCodeBtn').addEventListener('click',deleteLineCode);
  $('renumberBtn').addEventListener('click',()=>{renumberCaptures(true);toast('현재 촬영목록의 치구번호를 다시 배정했습니다.');});
  $('lineCodeSelect').addEventListener('change',()=>{suggestNextStart();if($('numberingMode').value==='continuous')renumberCaptures(true);});
  $('startNumber').addEventListener('input',()=>{updateNumberPreview();if($('numberingMode').value==='continuous')renumberCaptures(true);});
  $('numberingMode').addEventListener('change',()=>{updateNumberPreview();if($('numberingMode').value==='continuous')renumberCaptures(true);});
  $('maxShots').addEventListener('change',()=>{updateShotUI();updateNumberPreview();});
  $('newLineCode').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();addLineCode();}});

  document.addEventListener('visibilitychange',()=>{if(document.hidden)stopCamera();});
  window.addEventListener('pagehide',()=>{stopCamera();state.captures.forEach(revokeCapture);});

  if('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
    navigator.serviceWorker.register('./sw.js?v=0.6.4').then(reg=>reg.update()).catch(()=>{});
  }

  const APP_VERSION='0.6.4';
  if(/^https?:$/.test(location.protocol)){setTimeout(async()=>{try{const res=await fetch(`./version.json?t=${Date.now()}`,{cache:'no-store'});if(!res.ok)return;const latest=(await res.json()).version;if(!latest||latest===APP_VERSION)return;if('caches' in window){for(const key of await caches.keys())await caches.delete(key);}if('serviceWorker' in navigator){for(const reg of await navigator.serviceWorker.getRegistrations())await reg.unregister();}location.replace(`./?v=${encodeURIComponent(latest)}&refresh=${Date.now()}`);}catch(_){}},1800);}

  // Test hooks are available only when ?test=1 is present. They are not shown in normal use.
  if(new URLSearchParams(location.search).get('test')==='1'){
    window.__HOOK_TEST={
      async addFile(file,opts={}){const url=URL.createObjectURL(file),item={id:`test_${Date.now()}_${Math.random()}`,seq:state.seq++,blob:file,url,name:opts.name||makeJigNumber(currentCaptureCode(),state.seq),diameter:opts.diameter||6,material:opts.material||'SUS304',approxWidth:opts.approxWidth||'',approxHeight:opts.approxHeight||'',measureMode:opts.measureMode||'manual',arMmPerPx:opts.arMmPerPx||null,arDistanceMm:opts.arDistanceMm||null};state.captures.push(item);renderCaptureList();updateShotUI();return item.id;},
      analyze:batchAnalyze,
      state
    };
  }

  loadLineSettings(); setAppMode('jig'); renderCaptureList();updateShotUI();renderResults();updateNumberPreview();setStatus('준비');
})();
