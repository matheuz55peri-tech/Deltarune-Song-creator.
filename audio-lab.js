"use strict";
/* Darkwave Audio Lab: offline/local-only humming transcription and approximate spectral arrangement.
   No model or server upload; processing stays in browser. */
(function () {
  const $ = (id) => document.getElementById(id);
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const PITCH_MIN = 45, PITCH_MAX = 72, SAMPLE_RATE = 11025;
  const YIN_HOP = 512;
  const waitFrame = () => new Promise((resolve) => setTimeout(resolve, 0));
  const bins = (n) => Array.from({length:n}, () => 0);
  let recorder = null;
  let micStream = null, micCtx = null, micAnalyser = null, micRaf = null;
  let audioChunks = [], recordBlob = null, recordedBuffer = null;
  let recordStarted = 0, recordTicker = null, recordStopTimer = null;
  let voicePreview = null, previewUrl = null, musicFile = null;
  let musicBuffer = null, busy = false, waveClock = 0;
  let operationActive = true;
  let comparisonPlayer = null, comparisonUrl = null;

  function notify(message) {
    const toast = $("toast");
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add("visible");
    clearTimeout(window.darkwaveLabToast);
    window.darkwaveLabToast = setTimeout(() => toast.classList.remove("visible"), 5000);
  }

  function status(message) { $("micStatus").textContent = message; }

  function setProgress(name, fraction, label) {
    const root = $(name + "Progress"), bar = $(name + "ProgressBar"), text = $(name + "ProgressText");
    root.hidden = false;
    bar.style.width = Math.round(clamp(fraction, 0, 1) * 100) + "%";
    text.textContent = label || ("Analisando " + Math.round(fraction * 100) + "%");
  }
  function hideProgress(name) { $(name + "Progress").hidden = true; }

  function toMono(buffer, maxSeconds) {
    const end = Math.min(Math.floor(buffer.duration * SAMPLE_RATE), Math.floor(maxSeconds * SAMPLE_RATE));
    const left = buffer.getChannelData(0);
    const right = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : null;
    const rate = buffer.sampleRate / SAMPLE_RATE;
    const data = new Float32Array(end);
    for (let i = 0; i < end; i++) {
      const pos = Math.min(left.length - 1, Math.floor(i * rate));
      data[i] = right ? (left[pos] + right[pos]) * .5 : left[pos];
    }
    return data;
  }
  function rmsAround(data, start, length) {
    let e = 0;
    const end = Math.min(data.length, start + length);
    for (let i = Math.max(0, start); i < end; i++) e += data[i] * data[i];
    return Math.sqrt(e / Math.max(1, end - Math.max(0, start)));
  }
  function median(arr) {
    if (!arr.length) return null;
    const a = arr.slice().sort((x, y) => x - y);
    return a[Math.floor(a.length / 2)];
  }
  function midiToLane(pitch) {
    // Keep octave shifts intact; no clamping of the melodic contour until necessary.
    while (pitch < PITCH_MIN) pitch += 12;
    while (pitch > PITCH_MAX) pitch -= 12;
    return clamp(pitch, PITCH_MIN, PITCH_MAX);
  }

  // Normalized autocorrelation with candidate continuity to mitigate octave errors.
  function getPitch(data, start, previousPitch) {
    const N = 900, minLag = 18, maxLag = 178;
    if (start < 0 || start + N + maxLag >= data.length) return null;
    const e = rmsAround(data, start, N);
    if (e < .009) return null;
    const correlations = new Float32Array(maxLag + 1);
    let best = 0;
    for (let lag = minLag; lag <= maxLag; lag++) {
      let dot = 0, a2 = 0, b2 = 0;
      for (let j = 0; j < N; j += 2) {
        const a = data[start + j], b = data[start + j + lag];
        dot += a * b; a2 += a * a; b2 += b * b;
      }
      const score = dot / Math.sqrt(a2 * b2 + 1e-12);
      correlations[lag] = score;
      best = Math.max(best, score);
    }
    if (best < .70) return null;
    const peaks = [];
    for (let lag = minLag + 1; lag < maxLag; lag++) {
      if (correlations[lag] >= Math.max(.72, best - .035) &&
          correlations[lag] >= correlations[lag - 1] && correlations[lag] > correlations[lag + 1]) {
        const frequency = SAMPLE_RATE / lag;
        const rawMidi = Math.round(69 + 12 * Math.log2(frequency / 440));
        if (rawMidi >= 38 && rawMidi <= 83)
          peaks.push({lag, pitch:midiToLane(rawMidi), confidence:correlations[lag], rms:e});
      }
    }
    if(!peaks.length) return null;
    // The first near-optimal autocorrelation peak is normally the fundamental.
    // Compare with previous note without rewarding spurious octave doubling.
    peaks.sort((a,b)=>a.lag-b.lag);
    let chosen=peaks[0], quality=-Infinity;
    for (const candidate of peaks) {
      const movement=previousPitch==null?0:Math.abs(candidate.pitch-previousPitch);
      const continuityPenalty=previousPitch==null?0:Math.max(0,movement-3)*.022;
      const harmonicPenalty=(candidate.lag/peaks[0].lag-1)*.022;
      const rank=candidate.confidence-continuityPenalty-harmonicPenalty;
      if (rank>quality) {chosen=candidate;quality=rank;}
    }
    return chosen;
  }

  function refinePitchSequence(sequence) {
    const result = sequence.map(x => x ? x.pitch : null);
    for (let i = 2; i < sequence.length - 2; i++) {
      const nearby = result.slice(i - 2, i + 3).filter(p => p != null);
      if (nearby.length >= 3) {
        const med = median(nearby);
        if (result[i] != null && Math.abs(result[i] - med) > 5 && sequence[i].confidence < .93)
          result[i] = med;
      }
    }
    // Replace single-frame glitches only if surrounding notes agree.
    for (let i = 1; i < result.length - 1; i++) {
      if(result[i-1] != null && result[i+1] === result[i-1] && (result[i] == null || Math.abs(result[i]-result[i-1]) >= 2))
        result[i] = result[i-1];
    }
    return result;
  }

  function noteFromFrames(values, frameSec, stepSec, gridSize, quantize, maxSteps) {
    const events = [];
    let current = null, startFrame = -1, total = 0;
    function flush(endFrame) {
      if (current == null || startFrame < 0) return;
      const duration = (endFrame - startFrame) * frameSec;
      if (duration < .095) return;
      let s = Math.round((startFrame * frameSec) / stepSec / quantize) * quantize;
      let e = Math.round((endFrame * frameSec) / stepSec / quantize) * quantize;
      s = clamp(s,0,maxSteps-1);
      e = clamp(Math.max(s+1,e),s+1,maxSteps);
      if (s >= maxSteps) return;
      let d = Math.min(32, e-s);
      const previous = events[events.length-1];
      if(previous && previous.p === current && s <= previous.s+previous.d+1) previous.d = Math.min(32, Math.max(previous.d,s+d-previous.s));
      else events.push({s,p:current,d,v:.85});
    }
    for(let i=0;i<=values.length;i++) {
      const next = i < values.length ? values[i] : null;
      if(next === current) {total++;continue;}
      if(current != null) flush(i);
      current = next; startFrame = next != null ? i : -1; total = 1;
    }
    return events;
  }

  function compressNotes(notes, maxSteps) {
    const sorted = notes.sort((a,b) => a.s-b.s || a.p-b.p);
    const grouped = [];
    for(const n of sorted){
      if(n.s < 0 || n.s >= maxSteps)continue;
      const d = clamp(n.d,1,32);
      const prev = grouped.find(x => x.p === n.p && x.s+x.d === n.s && x.d < 32);
      if(prev)prev.d=Math.min(32,prev.d+d);
      else if(!grouped.some(x=>x.p===n.p && x.s===n.s))grouped.push({...n, d:Math.min(d,maxSteps-n.s), v:.85});
    }
    return grouped.slice(0,1800);
  }

  function audioOnsets(samples, hop = 256) {
    const energies = [];
    const zcrs = [];
    for (let pos=0;pos+1024<samples.length;pos+=hop) {
      let e=0, z=0, low=0, high=0;
      for(let j=0;j<1024;j+=2) {
        const v=samples[pos+j], pv=samples[pos+j+2]||0;
        e+=v*v;
        z += (v>=0)!==(pv>=0) ? 1 : 0;
        if(j%8===0) {low+=Math.abs(v+pv); high+=Math.abs(v-pv);}
      }
      energies.push(Math.sqrt(e/512));
      zcrs.push({high: high/(low+high+.0001), rate:z/512});
    }
    const flux = energies.map((value,i) => {
      const previous=energies[Math.max(0,i-2)];
      return Math.max(0, value-previous)/(value+.01);
    });
    const onsets=[];
    const threshold=Math.max(.09, median(flux)||.12);
    for(let i=3;i<flux.length-3;i++) {
      if(flux[i] > Math.max(.16,threshold*1.8) && flux[i] > flux[i-1] && flux[i] >= flux[i+1] && energies[i]>.012)
        onsets.push({time:i*hop/SAMPLE_RATE,strength:flux[i],brightness:zcrs[i].rate});
    }
    return {onsets, energies, flux};
  }

  function estimateBpm(onsets,fallback) {
    if(onsets.length < 8)return fallback;
    const times=onsets.slice(0,160).map(n => n.time);
    let best=fallback,bestScore=-1;
    for(let bpm=70;bpm<=180;bpm+=2) {
      const beat=60/bpm;
      let score=0;
      // onset intervals matching a beat or its half/submultiple
      for(let i=0;i<times.length;i++) {
        for(let j=i+1;j<Math.min(times.length,i+9);j++){
          const delta=times[j]-times[i];
          if(delta>2.2)break;
          const phase=delta/beat;
          const err=Math.abs(phase-Math.round(phase));
          const halfErr=Math.abs(phase*2-Math.round(phase*2));
          if(err<.1)score+=1.1*(1-err*3);
          else if(halfErr<.09)score+=.36;
        }
      }
      score -= Math.abs(bpm-fallback)*.028;
      if(score>bestScore){bestScore=score;best=bpm;}
    }
    return clamp(best,60,190);
  }

  function arrangeRhythm(onsets,bpm,maxSteps) {
    const drums=[[],[]], stepSec=60/bpm/4;
    let lastKick=-10,lastHat=-10;
    for(const onset of onsets) {
      const step=Math.round(onset.time/stepSec);
      if(step<0||step>=maxSteps)continue;
      const low=onset.brightness<.22;
      if(low && step-lastKick >=2) {drums[0].push({s:step,p:48,d:1,v:.85});lastKick=step;}
      else if(step-lastHat >=1){drums[1].push({s:step,p:60,d:1,v:.85});lastHat=step;}
    }
    return drums.map(notes=>compressNotes(notes,maxSteps));
  }

  function removeSilenceStart(samples, secondsLimit=.35) {
    let p=0;
    const seek=Math.min(Math.floor(secondsLimit*SAMPLE_RATE),samples.length-2048);
    if(seek<=0)return 0;
    for(let i=0;i<seek;i+=256){
      if(rmsAround(samples,i,512)>.018){p=Math.max(0,i-256);break;}
    }
    return p;
  }

  async function transcribeVoice(buffer, config, report) {
    const data=toMono(buffer,65);
    if(data.length<4000)throw new Error("Grave pelo menos meio segundo de áudio.");
    const {onsets}=audioOnsets(data);
    const studio=window.DarkwaveStudio.settings();
    const bpm=config.tempo==="auto" ? estimateBpm(onsets,studio.bpm) : studio.bpm;
    const stepSec=60/bpm/4;
    const maxSteps=512;
    const quantize=Number(config.quantize)||2;
    const detected=[];
    const offset=removeSilenceStart(data);
    let previous=null, confidenceSum=0, voiced=0;
    for(let i=0,pos=offset;pos+1100<data.length;pos+=YIN_HOP,i++){
      const pitch=getPitch(data,pos,previous);
      if(pitch){previous=pitch.pitch;voiced++;confidenceSum+=pitch.confidence;}
      else if(i%3===0)previous=null;
      detected.push(pitch);
      if(i%40===0){report(Math.min(.82,pos/data.length*.82),"Reconhecendo notas da sua voz...");await waitFrame();}
    }
    const pitchRatio=voiced / Math.max(1,detected.length);
    const automaticallyRhythm=config.mode==="auto" && pitchRatio<.24;
    const isRhythm=config.mode==="rhythm" || automaticallyRhythm;
    const tracks=Array.from({length:8},()=>[]);
    if(isRhythm){
      const rhythm=arrangeRhythm(onsets,bpm,maxSteps);
      tracks[6]=rhythm[0];tracks[7]=rhythm[1];
      // When beat boxing has few transients, include clear energy peaks.
      if(!tracks[6].length&&!tracks[7].length)throw new Error("Não foram detectadas batidas claras. Tente sons curtos como 'tum, tss'.");
    }else{
      if(pitchRatio<.10)throw new Error("Não identifiquei uma altura de nota estável. Tente cantarolar notas longas e sem ruído de fundo.");
      const pitches=refinePitchSequence(detected);
      const frameSec=YIN_HOP/SAMPLE_RATE;
      // Keep input timing, including pauses. Start aligned to the grid, without fake notes.
      const extraFrames=Math.round(offset/YIN_HOP);
      const sequence=Array(extraFrames).fill(null).concat(pitches);
      const notes=noteFromFrames(sequence,frameSec,stepSec,64,quantize,maxSteps);
      if(!notes.length)throw new Error("Notas muito curtas ou pouco claras. Tente cantarolar de forma mais contínua.");
      const avg=median(notes.map(n=>n.p))||60;
      const articulation=onsets.length/Math.max(1,notes.length);
      // Basic timbre descriptors: brightness/zero-crossings and articulation.
      let changes=0, samplesCount=0;
      for(let k=0;k<data.length-2;k+=9){
        changes += (data[k]>=0)!==(data[k+2]>=0)?1:0;
        samplesCount++;
      }
      const brightness=changes/Math.max(1,samplesCount);
      let target=config.mode==="bass" || (config.mode==="auto" && avg<53) ? 3 : 0;
      if(config.mode==="auto" && target===0){
        if(articulation>2.0 && brightness>.10)target=5; // pluck
        else if(avg>=68 && brightness>.085)target=2; // bells
        else if(brightness<.047 && articulation<1.1)target=1; // soft keys
      }
      tracks[target]=compressNotes(notes,maxSteps);
    }
    report(1,"Análise concluída!");
    const used=tracks.flat().reduce((v,n)=>Math.max(v,n.s+n.d),0);
    return {title:"Minha Melodia Cantarolada",bpm,totalSteps:Math.max(64,used),tracks};
  }

  // Iterative radix-2 FFT with Hann window, suitable for short local audio segments.
  function spectrum(samples,start,size=4096) {
    const re=new Float32Array(size), im=new Float32Array(size);
    for(let i=0;i<size;i++){
      const at=start+i;
      const v=at>=0&&at<samples.length?samples[at]:0;
      re[i]=v*(.5-.5*Math.cos(2*Math.PI*i/(size-1)));
    }
    for(let i=1,j=0;i<size;i++){
      let bit=size>>1;
      for(;j&bit;bit>>=1)j^=bit;
      j^=bit;
      if(i<j){const t=re[i];re[i]=re[j];re[j]=t;}
    }
    for(let len=2;len<=size;len*=2){
      const angle=-2*Math.PI/len,wr=Math.cos(angle),wi=Math.sin(angle);
      for(let i=0;i<size;i+=len){
        let ur=1,ui=0;
        for(let j=0;j<len/2;j++){
          const a=i+j,b=a+len/2,vr=re[b]*ur-im[b]*ui,vi=re[b]*ui+im[b]*ur;
          re[b]=re[a]-vr;im[b]=im[a]-vi;re[a]+=vr;im[a]+=vi;
          const nr=ur*wr-ui*wi;ui=ur*wi+ui*wr;ur=nr;
        }
      }
    }
    const mags=new Float32Array(size/2);
    for(let i=0;i<mags.length;i++)mags[i]=Math.hypot(re[i],im[i]);
    return mags;
  }

  function localPeak(mags,hz) {
    const b=Math.round(hz*8192/(2*SAMPLE_RATE)); // 4096 / 11025 -> bin conversion
    if(b<2||b>=mags.length-2)return 0;
    return Math.max(mags[b-1],mags[b],mags[b+1]);
  }
  function spectralCandidates(mags) {
    const result=[];
    for(let pitch=PITCH_MIN;pitch<=PITCH_MAX;pitch++){
      const f=440*Math.pow(2,(pitch-69)/12);
      let salience=0;
      for(let h=1;h<=5;h++)salience+=localPeak(mags,f*h)/(h*.9);
      // Prefer stable fundamentals and suppress octave subharmonic ghosts.
      salience += localPeak(mags,f)*.65;
      result.push({pitch,score:salience});
    }
    return result;
  }

  function bestCandidate(candidates,lower,upper,previous) {
    let top=null;
    for(const candidate of candidates) {
      if(candidate.pitch<lower||candidate.pitch>upper)continue;
      const movement=previous==null?0:Math.abs(candidate.pitch-previous);
      const adjusted=candidate.score/(1 + Math.max(0,movement-3)*.055);
      if(!top||adjusted>top.value)top={pitch:candidate.pitch,score:candidate.score,value:adjusted};
    }
    return top;
  }

  async function arrangeImportedSong(buffer, config, report) {
    const data=toMono(buffer,75);
    if(data.length<4096)throw new Error("O arquivo é muito curto para desmontar.");
    const studio=window.DarkwaveStudio.settings();
    report(.04,"Procurando ritmo e andamento...");
    await waitFrame();
    const {onsets,energies}=audioOnsets(data);
    const bpm=estimateBpm(onsets,studio.bpm);
    const stepSec=60/bpm/4;
    const maxSteps=Math.min(512,Math.ceil((data.length/SAMPLE_RATE)/stepSec));
    const tracks=Array.from({length:8},()=>[]);
    const lead=[],bass=[],harmony=[],bell=[];
    let lastLead=null,lastBass=null;
    let globalMax=.001;
    for(let step=0;step<maxSteps;step++) {
      const center=Math.round((step+.47)*stepSec*SAMPLE_RATE);
      const rms=rmsAround(data,Math.max(0,center-1200),2400);
      if(rms<.009){lead.push(null);bass.push(null);harmony.push([]);bell.push(null);continue;}
      const mags=spectrum(data,center-2048);
      const candidates=spectralCandidates(mags);
      const maxVal=Math.max(...candidates.map(c=>c.score));
      globalMax=Math.max(globalMax,maxVal);
      const low=bestCandidate(candidates,45,57,lastBass);
      const upper=bestCandidate(candidates,55,72,lastLead);
      // A polyphonic mixture cannot truly isolate stems; enforce signal and confidence thresholds.
      const melodic=upper&&upper.score>=maxVal*.37?upper.pitch:null;
      const bassey=low&&low.score>=maxVal*.31?low.pitch:null;
      lead.push(melodic);bass.push(bassey);
      if(melodic!=null)lastLead=melodic;
      if(bassey!=null)lastBass=bassey;
      const harmonies=[];
      if(config.complexity!=="melody" && maxVal>.04){
        const ranked=candidates.filter(c=>c.score>=maxVal*(config.complexity==="rich"?.48:.67)).sort((a,b)=>b.score-a.score);
        for(const item of ranked){
          if(harmonies.length>=(config.complexity==="rich"?3:2))break;
          if(Math.abs(item.pitch-(melodic||0))<=1||Math.abs(item.pitch-(bassey||0))<=1)continue;
          if(harmonies.some(p=>Math.abs(p-item.pitch)<3))continue;
          harmonies.push(item.pitch);
        }
      }
      harmony.push(harmonies);
      bell.push(melodic!=null&&step%8===6?melodic:null);
      if(step%8===0){report(.12+step/maxSteps*.76,"Analisando melodia, harmonia e graves...");await waitFrame();}
    }
    const rhythm=arrangeRhythm(onsets,bpm,maxSteps);
    tracks[6]=rhythm[0];tracks[7]=rhythm[1];
    function frameNotes(arr,duration=1) {
      const out=[];
      let value=null,start=-1;
      for(let s=0;s<=arr.length;s++) {
        const next=s<arr.length?arr[s]:null;
        if(next===value)continue;
        if(value!=null&&start>=0&&s-start>=duration)out.push({s:start,p:value,d:clamp(s-start,1,32),v:.85});
        value=next;start=s;
      }
      return compressNotes(out,maxSteps);
    }
    // 1-step gaps are considered sustain where they preserve a local pitch.
    for(const seq of [lead,bass]){
      for(let i=1;i<seq.length-1;i++)
        if(seq[i]==null&&seq[i-1]!=null&&seq[i-1]===seq[i+1])seq[i]=seq[i-1];
    }
    tracks[0]=frameNotes(lead,1);
    tracks[3]=frameNotes(bass,1);
    if(config.complexity!=="melody"){
      const chordMap=new Map();
      for(let i=0;i<harmony.length;i++){
        for(const p of harmony[i]) {
          const seq=chordMap.get(p)||Array(maxSteps).fill(null);
          seq[i]=p;chordMap.set(p,seq);
        }
      }
      for(const seq of chordMap.values())tracks[1].push(...frameNotes(seq,config.complexity==="rich"?1:2));
      tracks[1]=compressNotes(tracks[1],maxSteps);
      tracks[2]=frameNotes(bell,1);
      // Long neighboring tones can create a soft ambient pad.
      tracks[4]=tracks[1].filter(n=>n.d>=4).map(n=>({...n,d:Math.min(n.d,16)}));
      if(config.complexity==="rich"){
        tracks[5]=tracks[0].filter((_,i)=>i%3===0).map(n=>({...n,s:Math.min(maxSteps-1,n.s+2),d:1}));
      }
    }
    const total=tracks.reduce((x,t)=>x+t.length,0);
    if(total<4)throw new Error("Não foi possível detectar notas suficientes. Tente áudio mais claro ou uma melodia solo.");
    report(1,"Arranjo experimental concluído!");
    return {title:"Arranjo Retrô — "+(config.title||"Áudio"),bpm,totalSteps:Math.max(64,maxSteps),tracks};
  }

  function drawVoiceWave() {
    const canvas=$("voiceWave"),ctx=canvas.getContext("2d");
    if(!ctx)return;
    const w=canvas.width,h=canvas.height;
    ctx.clearRect(0,0,w,h);
    ctx.fillStyle="#0a1926";ctx.fillRect(0,0,w,h);
    for(let x=0;x<w;x+=24){ctx.fillStyle="#244e64";ctx.fillRect(x,0,1,h);}
    ctx.fillStyle="#205168";ctx.fillRect(0,h/2,w,1);
    ctx.beginPath();
    ctx.strokeStyle="#38e9f2";ctx.lineWidth=2.5;
    const values=new Uint8Array(micAnalyser?micAnalyser.fftSize:1024);
    if(micAnalyser)micAnalyser.getByteTimeDomainData(values);
    else if(recordedBuffer) {
      const data=recordedBuffer.getChannelData(0);
      for(let i=0;i<values.length;i++){
        const v=data[Math.floor(i/values.length*data.length)]||0;
        values[i]=Math.round((v+1)*128);
      }
    }else {
      for(let i=0;i<values.length;i++)values[i]=128+Math.sin(i*.06+waveClock)*2;
    }
    for(let i=0;i<values.length;i++) {
      const x=i/(values.length-1)*w,y=(values[i]/128-1)*h*.42+h/2;
      if(i===0)ctx.moveTo(x,y);else ctx.lineTo(x,y);
    }
    ctx.stroke();
    waveClock+=.04;
    if(micAnalyser)micRaf=requestAnimationFrame(drawVoiceWave);
  }

  function clearMicVisual() {
    if(micRaf)cancelAnimationFrame(micRaf);
    micRaf=null;micAnalyser=null;
    drawVoiceWave();
  }
  function stopMediaTracks() {
    if(micStream){micStream.getTracks().forEach(t=>t.stop());micStream=null;}
    if(micCtx){micCtx.close().catch(()=>{});micCtx=null;}
    clearInterval(recordTicker);clearTimeout(recordStopTimer);
    clearMicVisual();
  }

  async function startRecording() {
    if(busy || recorder && recorder.state==="recording")return;
    if(!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      status("Microfone indisponível. Abra o site usando HTTPS e permita o acesso.");
      return;
    }
    if(typeof MediaRecorder==="undefined"){status("Este navegador não suporta gravação. Tente Chrome ou Firefox.");return;}
    try{
      if(voicePreview){voicePreview.pause();voicePreview=null;}
      recordBlob=null;recordedBuffer=null;audioChunks=[];
      micStream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:false,noiseSuppression:false,autoGainControl:false}});
      const mime=["audio/webm;codecs=opus","audio/webm","audio/mp4"].find(m=>MediaRecorder.isTypeSupported(m));
      recorder=mime?new MediaRecorder(micStream,{mimeType:mime}):new MediaRecorder(micStream);
      recorder.ondataavailable=(e)=>{if(e.data.size)audioChunks.push(e.data);};
      recorder.onerror=(e)=>{status("Houve um erro na gravação.");stopMediaTracks();};
      recorder.onstop=async()=>{
        recordBlob=new Blob(audioChunks,{type:recorder.mimeType||"audio/webm"});
        stopMediaTracks();
        try{
          const Ctx=window.AudioContext||window.webkitAudioContext;
          const temp=new Ctx();
          recordedBuffer=await temp.decodeAudioData(await recordBlob.arrayBuffer());
          await temp.close();
          $("micReplayBtn").disabled=false;$("voiceCreateBtn").disabled=false;
          status("Gravação pronta ("+recordedBuffer.duration.toFixed(1)+" s). Você pode escutar e transformar em notas.");
        }catch(err){
          status("Seu navegador não conseguiu decodificar esta gravação. Experimente Chrome ou Firefox.");
          recordedBuffer=null;
        }
      };
      recorder.start(250);recordStarted=performance.now();
      $("micStartBtn").disabled=true;$("micStopBtn").disabled=false;
      $("micReplayBtn").disabled=true;$("voiceCreateBtn").disabled=true;
      status("● Gravando... Cante uma nota por vez ou faça batidas como 'tum, tss'.");
      micCtx=new (window.AudioContext||window.webkitAudioContext)();
      const micSource=micCtx.createMediaStreamSource(micStream);
      micAnalyser=micCtx.createAnalyser();micAnalyser.fftSize=1024;
      micSource.connect(micAnalyser);
      drawVoiceWave();
      recordTicker=setInterval(()=>{
        const secs=Math.floor((performance.now()-recordStarted)/1000);
        $("recordTimer").textContent=String(Math.floor(secs/60)).padStart(2,"0")+":"+String(secs%60).padStart(2,"0");
      },250);
      recordStopTimer=setTimeout(stopRecording,45000);
    }catch(err){
      if(recorder && recorder.state==="recording")recorder.stop();
      stopMediaTracks();
      status(err.name==="NotAllowedError"?"Permissão negada: libere o microfone nas configurações do navegador.":"Não foi possível iniciar o microfone: "+err.message);
      $("micStartBtn").disabled=false;$("micStopBtn").disabled=true;
    }
  }

  function stopRecording() {
    $("micStopBtn").disabled=true;$("micStartBtn").disabled=false;
    if(recorder&&recorder.state==="recording")recorder.stop();
    else stopMediaTracks();
  }

  async function replayRecording() {
    if(!recordBlob)return;
    if(voicePreview)voicePreview.pause();
    if(previewUrl)URL.revokeObjectURL(previewUrl);
    previewUrl=URL.createObjectURL(recordBlob);
    voicePreview=new Audio(previewUrl);
    try{await voicePreview.play();}catch(err){notify("Seu navegador bloqueou a reprodução. Toque novamente.");}
  }

  async function importVoice() {
    if(!recordedBuffer||busy)return;
    busy=true;$("voiceCreateBtn").disabled=true;
    try{
      const config={mode:$("voiceMode").value,quantize:$("voiceQuantize").value,tempo:$("voiceTempo").value};
      const data=await transcribeVoice(recordedBuffer,config,(v,t)=>setProgress("voice",v,t));
      window.DarkwaveStudio.setArrangement(data,$("voiceImportMode").value);
      status("✓ Melodia analisada! Confira as notas no estúdio.");
    }catch(err){notify(err.message);status("Análise incompleta: "+err.message);}
    finally{busy=false;$("voiceCreateBtn").disabled=false;setTimeout(()=>hideProgress("voice"),1800);}
  }

  async function importMusic() {
    if(busy)return;
    const file=$("audioFile").files[0];
    const shared=window.DarkwaveStudio.importedAudio();
    if(!file && !shared) { notify("Selecione primeiro uma música na área de importação.");$("selectAudioBtn").focus();return; }
    if(file && file.size>45*1024*1024){notify("Arquivo muito grande. Use até 45 MB.");return;}
    busy=true;$("importArrangementBtn").disabled=true;
    try{
      let sourceName=file?file.name:shared.name;
      if(shared && (!file || shared.name===file.name)) {
        musicBuffer=shared.buffer;
        musicFile=file||shared.name;
      } else if(file!==musicFile||!musicBuffer) {
        setProgress("import",.01,"Lendo arquivo de áudio...");
        const Ctx=window.AudioContext||window.webkitAudioContext;
        const ctx=new Ctx();
        try{musicBuffer=await ctx.decodeAudioData(await file.arrayBuffer());musicFile=file;}
        finally{await ctx.close();}
      }
      const analyze = window.DarkwaveAnalyzerV3 && window.DarkwaveAnalyzerV3.arrange;
      if (!analyze) throw new Error("Analisador não carregou. Atualize a página.");
      const data=await analyze(musicBuffer,{
        complexity:$("importComplexity").value,
        title:sourceName.replace(/\.[^.]+$/,""),
        tempo:$("importTempo").value
      },(v,t)=>setProgress("import",v,t));
      window.DarkwaveStudio.setArrangement(data,$("importMode").value);
      $("conversionFeedback").textContent="✓ "+data.analysis.notes+" notas sugeridas · "+data.bpm+" BPM estimados · instrumentos retrô selecionados. Compare com a gravação: a reconstrução em MIDI é aproximada, mas a conversão de áudio fiel preserva a interpretação original.";
      notify("Arranjo criado. Ouça o original e troque os timbres se necessário.");
    }catch(err){notify("Erro na análise: "+err.message);}
    finally{busy=false;$("importArrangementBtn").disabled=false;setTimeout(()=>hideProgress("import"),2200);}
  }


  function stopComparison(){
    if(comparisonPlayer){comparisonPlayer.pause();comparisonPlayer.currentTime=0;comparisonPlayer=null;}
    if(comparisonUrl){URL.revokeObjectURL(comparisonUrl);comparisonUrl=null;}
  }
  async function playComparison(kind) {
    try {
      const audio=window.DarkwaveStudio.importedAudio();
      if(!audio||!audio.file)throw new Error("Importe uma música antes de comparar.");
      stopComparison();
      const blob=kind==="original"?audio.file:window.DarkwaveStudio.retroAudioBlob();
      comparisonUrl=URL.createObjectURL(blob);
      comparisonPlayer=new Audio(comparisonUrl);
      const feedback=$("conversionFeedback");
      feedback.textContent=kind==="original"?
        "▶ Tocando a gravação original, sem alterações.":
        "▶ Tocando a gravação com textura retrô. O áudio preserva a melodia e o ritmo originais.";
      comparisonPlayer.addEventListener("ended",()=>{feedback.textContent="Reprodução concluída.";stopComparison();},{once:true});
      await comparisonPlayer.play();
    }catch(e){notify("Não foi possível reproduzir: "+e.message);}
  }

  function init(){
    if(!window.DarkwaveStudio){console.error("DarkwaveAudioLab requer app.js carregado primeiro");return;}
    $("micStartBtn").addEventListener("click",startRecording);
    $("micStopBtn").addEventListener("click",stopRecording);
    $("micReplayBtn").addEventListener("click",replayRecording);
    $("voiceCreateBtn").addEventListener("click",importVoice);
    $("importArrangementBtn").addEventListener("click",importMusic);
    $("playReferenceBtn").addEventListener("click",()=>playComparison("original"));
    $("playRetroBtn").addEventListener("click",()=>playComparison("retro"));
    $("stopReferenceBtn").addEventListener("click",stopComparison);
    $("audioFile").addEventListener("change",()=>{musicFile=null;musicBuffer=null;stopComparison();});
    $("dropArea").addEventListener("drop",()=>{musicFile=null;musicBuffer=null;stopComparison();});
    drawVoiceWave();
    document.addEventListener("visibilitychange",()=>{
      if(document.hidden && recorder && recorder.state==="recording")status("Gravação em andamento. Mantenha esta página aberta.");
    });
  }
  init();
})();