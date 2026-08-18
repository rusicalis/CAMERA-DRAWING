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
    working: false
  };

  const MAX_ANALYSIS_SIDE = 820;
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
  function safeName(s) { return String(s || 'S-HOOK').replace(/[\\/:*?"<>|\s]+/g, '_'); }

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
      const url = URL.createObjectURL(blob);
      const prefix = $('namePrefix').value.trim() || 'S-HOOK';
      const item = {
        id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}_${Math.random()}`,
        seq: state.seq++,
        blob, url,
        name: `${prefix}-${String(state.seq - 1).padStart(2, '0')}`,
        diameter: parseFloat($('defaultDiameter').value) || 6,
        material: $('defaultMaterial').value.trim() || 'SUS304',
        approxWidth: '',
        approxHeight: ''
      };
      state.captures.push(item);
      renderCaptureList();
      updateShotUI();
      setStatus(`${state.captures.length}장 촬영`, 'ok');
      toast(`${item.name} 촬영 완료 · 사진첩 저장 안 함`);
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
    $('batchAnalyzeBtn').disabled = count === 0 || state.working;
    if (state.stream) $('captureBtn').disabled = count >= (parseInt($('maxShots').value,10)||10) || state.working;
  }

  function renderCaptureList() {
    const host = $('captureList');
    if (!state.captures.length) {
      host.innerHTML = '<div class="empty-state">아직 촬영된 치구가 없습니다.</div>';
      return;
    }
    host.innerHTML = state.captures.map((c, i) => `
      <div class="capture-item" data-id="${c.id}">
        <img class="capture-thumb" src="${c.url}" alt="촬영 ${i+1}">
        <div>
          <div class="capture-head"><b>${i+1}. ${esc(c.name)}</b><button class="icon-btn delete-shot" data-id="${c.id}">삭제</button></div>
          <div class="capture-fields">
            <label class="wide">도면명<input data-field="name" value="${esc(c.name)}" maxlength="40"></label>
            <label>Ø mm<input data-field="diameter" type="number" min="0.5" max="50" step="0.1" value="${esc(c.diameter)}"></label>
            <label>재질<input data-field="material" value="${esc(c.material)}" maxlength="40"></label>
            <label>대략 폭 mm<input data-field="approxWidth" type="number" min="1" max="3000" step="1" value="${esc(c.approxWidth)}" placeholder="선택"></label>
            <label>대략 높이 mm<input data-field="approxHeight" type="number" min="1" max="3000" step="1" value="${esc(c.approxHeight)}" placeholder="선택"></label>
          </div>
          <span class="field-note">대략 폭/높이를 입력하면 격자 자동값보다 이 값으로 치수 스케일을 우선 보정합니다.</span>
        </div>
      </div>`).join('');
  }

  $('captureList').addEventListener('input', e => {
    const field = e.target.dataset?.field;
    if (!field) return;
    const row = e.target.closest('.capture-item');
    const item = state.captures.find(c => c.id === row?.dataset.id);
    if (!item) return;
    if (['diameter','approxWidth','approxHeight'].includes(field)) item[field] = e.target.value;
    else item[field] = e.target.value;
  });

  $('captureList').addEventListener('click', e => {
    const btn = e.target.closest('.delete-shot');
    if (!btn || state.working) return;
    const idx = state.captures.findIndex(c => c.id === btn.dataset.id);
    if (idx < 0) return;
    revokeCapture(state.captures[idx]);
    state.captures.splice(idx, 1);
    renderCaptureList(); updateShotUI();
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

  function projectionSignals(gray,w,h) {
    const sx = new Float64Array(w), sy = new Float64Array(h);
    const y0=Math.floor(h*.05), y1=Math.floor(h*.95), x0=Math.floor(w*.05), x1=Math.floor(w*.95);
    for(let y=y0;y<y1;y++){
      const row=y*w;
      for(let x=x0+1;x<x1;x++) sx[x] += Math.abs(gray[row+x]-gray[row+x-1]);
    }
    for(let x=x0;x<x1;x++) for(let y=y0+1;y<y1;y++) sy[y] += Math.abs(gray[y*w+x]-gray[(y-1)*w+x]);
    return {sx,sy};
  }

  function findPeriod(signal) {
    const n=signal.length;
    let mean=0; for(const v of signal) mean+=v; mean/=n;
    const z=new Float64Array(n); let variance=0;
    for(let i=0;i<n;i++){z[i]=signal[i]-mean;variance+=z[i]*z[i];}
    if(variance<1e-6) return {lag:0,score:0};
    const minLag=Math.max(5,Math.floor(n/140));
    const maxLag=Math.min(Math.floor(n/3),190);
    const scores=[]; let bestLag=0,best=-Infinity;
    for(let lag=minLag;lag<=maxLag;lag++){
      let num=0,a2=0,b2=0;
      for(let i=0;i<n-lag;i++){const a=z[i],b=z[i+lag];num+=a*b;a2+=a*a;b2+=b*b;}
      const s=num/(Math.sqrt(a2*b2)+1e-9);scores.push([lag,s]);
      if(s>best){best=s;bestLag=lag;}
    }
    const rawAt=lag=>{let hit=-1,delta=Infinity;for(const v of scores){const d=Math.abs(v[0]-lag);if(d<delta){delta=d;hit=v[1];}}return delta<=1?hit:-1;};
    const bestRaw=rawAt(bestLag);
    for(const div of [4,3,2]){
      const cand=Math.round(bestLag/div); if(cand<minLag) continue;
      const c=rawAt(cand),h2=rawAt(cand*2),h3=rawAt(cand*3);
      if(c>Math.max(.10,bestRaw*.40) && (h2>bestRaw*.42 || h3>bestRaw*.42)) bestLag=cand;
    }
    return {lag:bestLag,score:clamp(rawAt(bestLag),0,1)};
  }

  function detectGrid(gray,w,h) {
    const {sx,sy}=projectionSignals(gray,w,h), px=findPeriod(sx),py=findPeriod(sy);
    const u=[];
    if(px.score>.11&&px.lag>0)u.push(px); if(py.score>.11&&py.lag>0)u.push(py);
    if(!u.length)return {pitch:null,confidence:0};
    u.sort((a,b)=>b.score-a.score);
    let pitch=u[0].lag,conf=u[0].score;
    if(u.length===2){const ratio=Math.max(u[0].lag,u[1].lag)/Math.min(u[0].lag,u[1].lag);if(ratio<1.18){pitch=(u[0].lag*u[0].score+u[1].lag*u[1].score)/(u[0].score+u[1].score);conf=(u[0].score+u[1].score)/2;}else conf*=.62;}
    return {pitch,confidence:clamp(conf*1.28,0,.98)};
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

  function largestComponent(mask,w,h) {
    const seen=new Uint8Array(mask.length),q=new Int32Array(mask.length);let best=null;
    const dirs=[-1,1,-w,w,-w-1,-w+1,w-1,w+1];
    for(let i=0;i<mask.length;i++){
      if(!mask[i]||seen[i])continue;let qs=0,qe=0;q[qe++]=i;seen[i]=1;let area=0,minX=w,minY=h,maxX=0,maxY=0;const pix=[];
      while(qs<qe){const p=q[qs++],y=(p/w)|0,x=p-y*w;pix.push(p);area++;if(x<minX)minX=x;if(x>maxX)maxX=x;if(y<minY)minY=y;if(y>maxY)maxY=y;
        for(const d of dirs){const n=p+d;if(n<0||n>=mask.length||seen[n]||!mask[n])continue;const ny=(n/w)|0,nx=n-ny*w;if(Math.abs(nx-x)>1||Math.abs(ny-y)>1)continue;seen[n]=1;q[qe++]=n;}
      }
      const bw=maxX-minX+1,bh=maxY-minY+1,span=Math.max(bw,bh),small=Math.max(1,Math.min(bw,bh)),fill=area/(bw*bh),border=(minX<2||minY<2||maxX>w-3||maxY>h-3);
      const elong=span/small;
      let score=area*Math.max(.35,Math.min(2.4,elong));
      if(fill>.82)score*=.35;if(fill<.015)score*=.55;if(border)score*=.72;
      if(!best||score>best.score)best={area,minX,minY,maxX,maxY,pix,score,fill,elong};
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

  function chooseComponent(gray,w,h,pitchPx) {
    const t=otsu(gray);
    const candidates=[];
    for(const [thr,invert] of [[clamp(Math.round(t*.88),30,220),false],[clamp(Math.round(t*1.10),30,225),true]]){
      const r=processedComponent(gray,w,h,thr,invert,pitchPx);
      if(r.comp) candidates.push({...r,threshold:thr,invert});
    }
    if(!candidates.length)return null;
    candidates.sort((a,b)=>b.comp.score-a.comp.score);
    return candidates[0];
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

  async function analyzeCapture(item) {
    if (!item.blob) throw new Error('촬영 원본이 없습니다. 새로 촬영하세요.');
    const ds=await blobToCanvas(item.blob),gray=grayArray(ds.imageData),grid=detectGrid(gray,ds.w,ds.h);
    const pitch=grid.pitch||Math.max(18,Math.min(ds.w,ds.h)/20);
    const seg=chooseComponent(gray,ds.w,ds.h,pitch);
    if(!seg?.comp||seg.comp.area<Math.max(70,ds.w*ds.h*.00035)) throw new Error('치구 형상을 찾지 못했습니다. 배경과 치구 대비를 높여 다시 촬영하세요.');
    const comp=seg.comp,crop=cropComponent(comp,ds.w,ds.h,5),sk=skeletonize(crop.mask,crop.w,crop.h);
    let path=skeletonPath(sk,crop.w,crop.h);if(path.length<8)throw new Error('중심선 추출 실패. 치구 전체가 격자 위에 보이도록 다시 촬영하세요.');
    path=path.map(p=>({x:p.x+crop.x0,y:p.y+crop.y0}));
    path=smoothPath(path,Math.max(1,Math.round(pitch*.015)));path=decimatePath(path,Math.max(1.3,pitch*.025));

    const bboxW=comp.maxX-comp.minX+1,bboxH=comp.maxY-comp.minY+1;
    const approxW=parseFloat(item.approxWidth),approxH=parseFloat(item.approxHeight);
    const userScales=[];
    if(Number.isFinite(approxW)&&approxW>0)userScales.push(approxW/bboxW);
    if(Number.isFinite(approxH)&&approxH>0)userScales.push(approxH/bboxH);
    let mmPerPx,scaleSource,scaleConfidence;
    if(userScales.length){mmPerPx=userScales.reduce((a,b)=>a+b,0)/userScales.length;scaleSource='사용자 대략치수';scaleConfidence=.92;}
    else if(grid.pitch){mmPerPx=10/grid.pitch;scaleSource='1cm 격자 자동';scaleConfidence=grid.confidence;}
    else throw new Error('1cm 격자를 찾지 못했습니다. 촬영 목록에서 대략 폭 또는 높이를 한 가지 이상 입력한 뒤 다시 생성하세요.');

    const diameter=Math.max(.1,parseFloat(item.diameter)||6),width=bboxW*mmPerPx,height=bboxH*mmPerPx,length=pathLength(path)*mmPerPx,r=estimateRadii(path,mmPerPx,comp,diameter);
    const pathMm=path.map(p=>({x:(p.x-comp.minX)*mmPerPx,y:(p.y-comp.minY)*mmPerPx}));
    const aspect=Math.max(width,height)/Math.max(1,Math.min(width,height));
    let quality=scaleConfidence*.48+(comp.fill<.60?.20:.08)+(aspect>1.18?.15:.08)+(path.length>18?.17:.10);quality=clamp(quality,.08,.99);
    return {
      id:item.id,name:item.name.trim()||`S-HOOK-${item.seq}`,material:item.material.trim()||'SUS304',diameter,
      baseWidth:width,baseHeight:height,baseLength:length,baseR1:r.r1,baseR2:r.r2,
      width,height,length,r1:r.r1,r2:r.r2,pathBase:pathMm,path:pathMm.map(p=>({...p})),
      scaleSource,scaleConfidence:grid.confidence,quality,threshold:seg.threshold,invert:seg.invert
    };
  }

  async function batchAnalyze() {
    if(!state.captures.length||state.working)return;
    state.working=true;updateShotUI();stopCamera();
    $('progressCard').classList.remove('hidden');$('resultsSection').classList.add('hidden');
    state.results=[];setStatus('일괄 분석중','busy');
    const total=state.captures.length;
    for(let i=0;i<total;i++){
      const item=state.captures[i];
      $('progressText').textContent=`${i+1} / ${total} · ${item.name} 분석 중`;
      $('progressBar').style.width=`${Math.round((i/total)*100)}%`;
      await new Promise(r=>setTimeout(r,25));
      try{
        const result=await analyzeCapture(item);state.results.push({...result,ok:true});
        // Privacy: once analysis succeeds, original capture is discarded from memory.
        revokeCapture(item);
      }catch(err){state.results.push({id:item.id,name:item.name,material:item.material,diameter:parseFloat(item.diameter)||6,ok:false,error:err?.message||String(err)});}
    }
    $('progressBar').style.width='100%';$('progressText').textContent=`${total}장 처리 완료`;
    // Remove successfully analyzed photographs from the capture queue/DOM as well.
    state.captures = state.captures.filter(c => c.blob);
    renderCaptureList();
    state.working=false;updateShotUI();renderResults();$('resultsSection').classList.remove('hidden');
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

  function makeSvg(r) {
    const W=1120,H=790,box={x:145,y:100,w:700,h:540};const path=transformedPath(r);
    let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;for(const p of path){minX=Math.min(minX,p.x);minY=Math.min(minY,p.y);maxX=Math.max(maxX,p.x);maxY=Math.max(maxY,p.y);}
    const pw=Math.max(1,maxX-minX),ph=Math.max(1,maxY-minY),scale=Math.min(box.w/pw,box.h/ph)*.86,ox=box.x+(box.w-pw*scale)/2,oy=box.y+(box.h-ph*scale)/2;
    const pts=path.map(p=>`${(ox+(p.x-minX)*scale).toFixed(1)},${(oy+(p.y-minY)*scale).toFixed(1)}`).join(' '),width=parseFloat(r.width)||r.baseWidth,height=parseFloat(r.height)||r.baseHeight,length=parseFloat(r.length)||pathLength(path),r1=parseFloat(r.r1),r2=parseFloat(r.r2);
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}">
      <rect width="${W}" height="${H}" fill="white"/>
      <g fill="none" stroke="#111827" stroke-width="2"><rect x="35" y="35" width="1050" height="720"/><line x1="870" y1="35" x2="870" y2="755"/><line x1="870" y1="540" x2="1085" y2="540"/><line x1="870" y1="625" x2="1085" y2="625"/><polyline points="${pts}" stroke="#111827" stroke-width="5" stroke-linejoin="round" stroke-linecap="round"/></g>
      <g font-family="-apple-system,BlinkMacSystemFont,'Segoe UI','Noto Sans KR',sans-serif" fill="#0f172a">
        <text x="55" y="67" font-size="18" font-weight="700">S-HOOK PHOTO DRAWING</text>
        <text x="890" y="78" font-size="12">DRAWING NAME</text><text x="890" y="107" font-size="20" font-weight="700">${esc(r.name)}</text>
        <text x="890" y="570" font-size="12">MATERIAL</text><text x="890" y="600" font-size="18" font-weight="700">${esc(r.material)}</text>
        <text x="890" y="655" font-size="12">WIRE</text><text x="890" y="684" font-size="18" font-weight="700">Ø ${n1(r.diameter)} mm</text>
        <text x="890" y="716" font-size="12">DEVELOPED ${n1(length)} mm</text>
        <text x="${box.x+box.w/2}" y="86" font-size="16" text-anchor="middle">전체 폭 ${n1(width)} mm</text>
        <text x="80" y="${box.y+box.h/2}" font-size="16" transform="rotate(-90 80 ${box.y+box.h/2})" text-anchor="middle">전체 높이 ${n1(height)} mm</text>
        <text x="750" y="180" font-size="15">상부 ${Number.isFinite(r1)?`R${n1(r1)}`:'R-'}</text><text x="750" y="505" font-size="15">하부 ${Number.isFinite(r2)?`R${n1(r2)}`:'R-'}</text>
        <text x="55" y="735" font-size="11" fill="#b45309">APPROXIMATE PHOTO-BASED DRAWING · VERIFY FINAL DIMENSIONS BEFORE FABRICATION</text>
      </g>
      <g stroke="#64748b" stroke-width="1.5" fill="none"><line x1="${box.x}" y1="92" x2="${box.x+box.w}" y2="92"/><line x1="${box.x}" y1="84" x2="${box.x}" y2="99"/><line x1="${box.x+box.w}" y1="84" x2="${box.x+box.w}" y2="99"/><line x1="95" y1="${box.y}" x2="95" y2="${box.y+box.h}"/><line x1="87" y1="${box.y}" x2="102" y2="${box.y}"/><line x1="87" y1="${box.y+box.h}" x2="102" y2="${box.y+box.h}"/></g>
    </svg>`;
  }

  function renderResults() {
    const host=$('resultList');
    if(!state.results.length){host.innerHTML='<div class="empty-state">생성된 도면이 없습니다.</div>';return;}
    host.innerHTML=state.results.map((r,i)=>{
      if(!r.ok)return `<div class="result-item failed" data-id="${r.id}"><div class="result-head"><b>${i+1}. ${esc(r.name)}</b><span class="source-badge quality bad">생성 실패</span></div><div class="result-msg">${esc(r.error)}<br>촬영 목록에 사진이 남아 있습니다. 대략 폭/높이를 입력하거나 다시 촬영한 뒤 일괄 생성을 다시 실행하세요.</div></div>`;
      const quality=r.quality>.76?'양호':r.quality>.53?'보통':'대략치';
      return `<div class="result-item" data-id="${r.id}">
        <div class="result-head"><b>${i+1}. ${esc(r.name)}</b><span class="source-badge ${r.quality<.53?'quality bad':''}">${esc(r.scaleSource)} · ${quality}</span></div>
        <div class="drawing-wrap">${makeSvg(r)}</div>
        <div class="edit-grid">
          <label>전체 폭 mm<input data-rfield="width" type="number" step="0.1" value="${n1(r.width)}"></label>
          <label>전체 높이 mm<input data-rfield="height" type="number" step="0.1" value="${n1(r.height)}"></label>
          <label>전개길이 mm<input data-rfield="length" type="number" step="0.1" value="${n1(r.length)}"></label>
          <label>상부 R mm<input data-rfield="r1" type="number" step="0.1" value="${n1(r.r1)}"></label>
          <label>하부 R mm<input data-rfield="r2" type="number" step="0.1" value="${n1(r.r2)}"></label>
          <label>Ø mm<input data-rfield="diameter" type="number" step="0.1" value="${n1(r.diameter)}"></label>
        </div>
        <div class="result-actions"><button class="btn apply-dims" data-id="${r.id}">폭/높이 형상 반영</button><button class="btn export-one" data-id="${r.id}">이 도면 PDF</button></div>
        <div class="result-msg">사진 원본은 분석 완료 후 앱 메모리에서 폐기됨 · 치수는 직접 수정 가능 · 형상 반영 버튼은 폭/높이에 맞춰 중심선을 보정합니다.</div>
      </div>`;
    }).join('');
  }

  $('resultList').addEventListener('input',e=>{
    const f=e.target.dataset?.rfield;if(!f)return;const row=e.target.closest('.result-item'),r=state.results.find(x=>x.id===row?.dataset.id);if(!r?.ok)return;const v=parseFloat(e.target.value);if(Number.isFinite(v))r[f]=v;
    const wrap=row.querySelector('.drawing-wrap');if(wrap)wrap.innerHTML=makeSvg(r);
  });

  $('resultList').addEventListener('click',async e=>{
    const apply=e.target.closest('.apply-dims'),one=e.target.closest('.export-one');
    if(apply){const r=state.results.find(x=>x.id===apply.dataset.id);if(!r?.ok)return;recalcFromDimensions(r);renderResults();toast('폭/높이를 중심선 형상에 반영했습니다.');}
    if(one){const r=state.results.find(x=>x.id===one.dataset.id);if(r?.ok)await exportPdf([r],`${safeName(r.name)}_drawing.pdf`);}
  });

  // ---------------- Export ----------------
  function textBytes(s){return new TextEncoder().encode(s);}
  function concatBytes(parts){let n=0;for(const p of parts)n+=p.length;const out=new Uint8Array(n);let o=0;for(const p of parts){out.set(p,o);o+=p.length;}return out;}
  function base64ToBytes(b64){const bin=atob(b64),u=new Uint8Array(bin.length);for(let i=0;i<bin.length;i++)u[i]=bin.charCodeAt(i);return u;}

  async function svgToJpeg(svg) {
    const blob=new Blob([svg],{type:'image/svg+xml;charset=utf-8'}),url=URL.createObjectURL(blob);
    try{
      const img=await new Promise((resolve,reject)=>{const im=new Image();im.onload=()=>resolve(im);im.onerror=()=>reject(new Error('도면 이미지 변환 실패'));im.src=url;});
      const c=document.createElement('canvas');c.width=1680;c.height=1185;const cx=c.getContext('2d');cx.fillStyle='white';cx.fillRect(0,0,c.width,c.height);cx.drawImage(img,0,0,c.width,c.height);
      const data=c.toDataURL('image/jpeg',.91).split(',')[1];return {bytes:base64ToBytes(data),w:c.width,h:c.height};
    }finally{URL.revokeObjectURL(url);}
  }

  async function makePdf(results) {
    const imgs=[];for(const r of results)imgs.push(await svgToJpeg(makeSvg(r)));
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
      text(tx,ty,5,ascii(r.name));text(tx,ty-10,4,`WIRE DIA ${n1(r.diameter)} mm`);text(tx,ty-20,4,`WIDTH ${n1(width)} mm`);text(tx,ty-30,4,`HEIGHT ${n1(height)} mm`);text(tx,ty-40,4,`DEVELOPED ${n1(length)} mm`);if(Number.isFinite(parseFloat(r.r1)))text(tx,ty-50,4,`R1 ~ ${n1(parseFloat(r.r1))} mm`);if(Number.isFinite(parseFloat(r.r2)))text(tx,ty-60,4,`R2 ~ ${n1(parseFloat(r.r2))} mm`);
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

  async function exportPdf(results,name='S-HOOK_batch_drawings.pdf') {
    if(!results.length)return;setStatus('PDF 생성중','busy');try{const pdf=await makePdf(results);await shareOrDownload(pdf,name);setStatus('PDF 생성 완료','ok');}catch(err){setStatus('PDF 실패','warn');alert(`PDF 생성 실패: ${err?.message||err}`);}
  }

  async function exportDxf() {
    const ok=state.results.filter(r=>r.ok);if(!ok.length)return;const text=makeBatchDxf(ok),blob=new Blob([text],{type:'application/dxf;charset=utf-8'});await shareOrDownload(blob,'S-HOOK_batch_drawings.dxf');
  }

  function newJob() {
    if(!confirm('현재 도면과 촬영 정보를 모두 지우고 새 촬영을 시작할까요?'))return;
    clearCaptures();state.results=[];$('resultsSection').classList.add('hidden');$('progressCard').classList.add('hidden');$('progressBar').style.width='0';state.seq=1;renderResults();setStatus('새 작업');window.scrollTo({top:0,behavior:'smooth'});
  }

  // ---------------- PWA install ----------------
  window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();state.deferredInstall=e;$('installBtn').classList.remove('hidden');});
  $('installBtn').addEventListener('click',async()=>{if(!state.deferredInstall)return;state.deferredInstall.prompt();await state.deferredInstall.userChoice;state.deferredInstall=null;$('installBtn').classList.add('hidden');});

  // ---------------- Events ----------------
  $('startCameraBtn').addEventListener('click',startCamera);
  $('stopCameraBtn').addEventListener('click',()=>{stopCamera();setStatus('카메라 꺼짐');});
  $('captureBtn').addEventListener('click',captureShot);
  $('clearShotsBtn').addEventListener('click',()=>{if(confirm('촬영한 사진을 모두 삭제할까요?'))clearCaptures();});
  $('batchAnalyzeBtn').addEventListener('click',batchAnalyze);
  $('exportPdfBtn').addEventListener('click',()=>exportPdf(state.results.filter(r=>r.ok),'S-HOOK_batch_drawings.pdf'));
  $('exportDxfBtn').addEventListener('click',exportDxf);
  $('newJobBtn').addEventListener('click',newJob);
  $('maxShots').addEventListener('change',updateShotUI);

  document.addEventListener('visibilitychange',()=>{if(document.hidden)stopCamera();});
  window.addEventListener('pagehide',()=>{stopCamera();state.captures.forEach(revokeCapture);});

  if('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) navigator.serviceWorker.register('./sw.js').catch(()=>{});

  // Test hooks are available only when ?test=1 is present. They are not shown in normal use.
  if(new URLSearchParams(location.search).get('test')==='1'){
    window.__SHOOK_TEST={
      async addFile(file,opts={}){const url=URL.createObjectURL(file),item={id:`test_${Date.now()}_${Math.random()}`,seq:state.seq++,blob:file,url,name:opts.name||`TEST-${state.seq}`,diameter:opts.diameter||6,material:'SUS304',approxWidth:opts.approxWidth||'',approxHeight:opts.approxHeight||''};state.captures.push(item);renderCaptureList();updateShotUI();return item.id;},
      analyze:batchAnalyze,
      state
    };
  }

  renderCaptureList();updateShotUI();renderResults();setStatus('준비');
})();
