"use strict";
/*
 * Darkwave Analyzer V3
 * Original, dependency-free harmonic/onset analysis.
 * An approximation: never claims to isolate real instruments.
 * Heavy operations yield to the main browser thread to retain a responsive UI.
 */
(function () {
  const SR=11025, FFT=4096, HOP=512, MAX_SEC=75, FIRST_BIN=14, LAST_BIN=1536;
  const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
  const yieldUI=()=>new Promise(resolve=>setTimeout(resolve,0));
  const midiHz=p=>440*Math.pow(2,(p-69)/12);
  const median=(a)=>{if(!a.length)return 0;const v=Array.from(a).sort((x,y)=>x-y);return v[v.length>>1];};
  const blankTracks=()=>Array.from({length:8},()=>[]);
  function mono(buffer) {
    const samples=Math.min(Math.floor(buffer.duration*SR),MAX_SEC*SR);
    const a=buffer.getChannelData(0),b=buffer.numberOfChannels>1?buffer.getChannelData(1):null;
    const down=buffer.sampleRate/SR, result=new Float32Array(samples);
    // Averaged multi-tap resampling: unlike point sampling, rejects some aliasing.
    for(let i=0;i<samples;i++){
      const center=i*down;
      let sum=0;
      for(let k=-1;k<=2;k++){
        const at=clamp(Math.round(center+k*.22*down),0,a.length-1);
        sum+=(a[at]+(b?b[at]:a[at]))*.125;
      }
      result[i]=sum;
    }
    return result;
  }
  function fftMagnitude(signal,start) {
    const r=new Float32Array(FFT),im=new Float32Array(FFT);
    for(let i=0;i<FFT;i++){
      const pos=start+i;
      const w=.5-.5*Math.cos(2*Math.PI*i/(FFT-1));
      r[i]=(pos>=0&&pos<signal.length?signal[pos]:0)*w;
    }
    for(let i=1,j=0;i<FFT;i++){
      let bit=FFT>>1;
      while(j&bit){j^=bit;bit>>=1;}
      j^=bit;
      if(i<j){const v=r[i];r[i]=r[j];r[j]=v;}
    }
    for(let len=2;len<=FFT;len<<=1){
      const angle=-2*Math.PI/len,cos=Math.cos(angle),sin=Math.sin(angle);
      for(let base=0;base<FFT;base+=len){
        let ar=1,ai=0;
        for(let j=0;j<(len>>1);j++){
          const x=base+j,y=x+(len>>1);
          const tr=ar*r[y]-ai*im[y],ti=ar*im[y]+ai*r[y];
          r[y]=r[x]-tr;im[y]=im[x]-ti;
          r[x]+=tr;im[x]+=ti;
          const nr=ar*cos-ai*sin;
          ai=ar*sin+ai*cos;ar=nr;
        }
      }
    }
    const out=new Float32Array(LAST_BIN+1);
    for(let i=FIRST_BIN;i<=LAST_BIN;i++){
      // Magnitudes are compressed to avoid a single very loud partial winning.
      out[i]=Math.sqrt(Math.hypot(r[i],im[i]));
    }
    return out;
  }
  function percentile(arr,q) {
    const values=Array.from(arr).filter(x=>x>0).sort((a,b)=>a-b);
    if(!values.length)return 0;
    return values[Math.floor((values.length-1)*q)]||0;
  }
  function spectralFeature(spectrogram,index,bin) {
    const s=spectrogram[index];
    return s[bin]||0;
  }
  // Temporal median approximates sustained/harmonic content.
  function harmonicBin(specs,frame,bin) {
    // Fast 3-frame median; avoids excessive heap allocations and retains
    // short 8-bit note attacks better than a wider temporal median.
    const a=specs[Math.max(0,frame-1)][bin]||0;
    const b=specs[frame][bin]||0;
    const c=specs[Math.min(specs.length-1,frame+1)][bin]||0;
    return a>b?(b>c?b:a>c?c:a):(a>c?a:b>c?c:b);
  }
  function peak(specs,frame,frequency) {
    const middle=Math.round(frequency*FFT/SR);
    if(middle<FIRST_BIN+2||middle>LAST_BIN-2)return 0;
    let maximum=0;
    for(let b=middle-1;b<=middle+1;b++){
      const center=harmonicBin(specs,frame,b);
      const neighbors=(harmonicBin(specs,frame,b-3)+harmonicBin(specs,frame,b+3))*.5;
      // Compare to local spectrum floor. Values are not linear magnitudes.
      maximum=Math.max(maximum, Math.max(0,center-neighbors*.52));
    }
    return maximum;
  }
  function notesAtFrame(specs,frame) {
    const score=new Float32Array(86);
    let max=0;
    for(let pitch=40;pitch<=84;pitch++){
      const base=midiHz(pitch);
      const f1=peak(specs,frame,base), f2=peak(specs,frame,base*2);
      const f3=peak(specs,frame,base*3),f4=peak(specs,frame,base*4);
      // Fundamental is necessary for monophonic notes, upper harmonics
      // support bright synths but cannot invent a lower octave on their own.
      const value=f1*1.25+f2*.38+f3*.21+f4*.11;
      score[pitch]=value;
      max=Math.max(max,value);
    }
    return {score,max};
  }
  function localSpectralOnsets(specs) {
    const flux=new Float32Array(specs.length);
    const lowFlux=new Float32Array(specs.length);
    const highFlux=new Float32Array(specs.length);
    for(let t=1;t<specs.length;t++){
      let sum=0,low=0,high=0;
      for(let bin=FIRST_BIN;bin<LAST_BIN;bin+=3){
        const delta=Math.max(0,specs[t][bin]-specs[t-1][bin]);
        sum+=delta;
        if(bin<70)low+=delta;
        if(bin>380)high+=delta;
      }
      flux[t]=sum;lowFlux[t]=low;highFlux[t]=high;
    }
    const base=percentile(flux,.62);
    const threshold=Math.max(.003,base*1.6);
    const peaks=[];
    for(let t=2;t<specs.length-2;t++){
      if(flux[t] > threshold && flux[t] > flux[t-1] && flux[t] >= flux[t+1] &&
        (!peaks.length || t-peaks[peaks.length-1].frame>=2)){
        peaks.push({frame:t,time:t*HOP/SR,strength:flux[t],low:lowFlux[t],high:highFlux[t]});
      }
    }
    return {peaks,flux,lowFlux,highFlux};
  }
  function detectTempo(onsets,fallback) {
    if(onsets.length<8)return fallback;
    let best=fallback,bestScore=-Infinity;
    for(let bpm=68;bpm<=184;bpm+=2){
      const quarter=60/bpm;
      let score=0;
      for(let i=0;i<onsets.length;i++){
        for(let j=i+1;j<Math.min(i+9,onsets.length);j++){
          const distance=onsets[j].time-onsets[i].time;
          if(distance>2)break;
          const nearQuarter=Math.abs(distance/quarter-Math.round(distance/quarter));
          const nearHalf=Math.abs(distance*2/quarter-Math.round(distance*2/quarter));
          if(nearQuarter<.13)score+=(1-nearQuarter*4)*.95;
          else if(nearHalf<.11)score+=(1-nearHalf*4)*.28;
        }
      }
      // BPM estimation isn't perfect; moderately favor the composer setting.
      score-=Math.abs(bpm-fallback)*.033;
      if(score>bestScore){bestScore=score;best=bpm;}
    }
    return best;
  }
  function findGridOffset(onsets,bpm) {
    const interval=60/bpm/4;
    if(onsets.length<3)return 0;
    let best=0,score=-Infinity;
    for(let k=0;k<16;k++){
      const phase=k/16*interval;
      let total=0;
      for(const hit of onsets){
        const delta=(hit.time-phase)/interval;
        const dist=Math.abs(delta-Math.round(delta));
        total+=Math.max(0,.18-dist)*Math.sqrt(hit.strength);
      }
      if(total>score){score=total;best=phase;}
    }
    return best;
  }
  function smooth(values) {
    const result=values.slice();
    for(let i=2;i<values.length-2;i++){
      const current=values[i],previous=values[i-1],next=values[i+1];
      if(previous!=null&&previous===next&&current!==previous)result[i]=previous;
    }
    return result;
  }
  function chooseMelody(features,start,end,previous,maxTotal) {
    const options=[];
    for(let pitch=start;pitch<=end;pitch++){
      const value=features.score[pitch];
      if(value<features.max*.38 || value < maxTotal*.08)continue;
      // Penalize melody jumps but allow them if evidence is strong.
      const distance=previous==null?0:Math.abs(pitch-previous);
      const adjusted=value/(1+Math.max(0,distance-3)*.055);
      options.push({pitch,score:adjusted});
    }
    options.sort((a,b)=>b.score-a.score);
    return options[0]?.pitch??null;
  }
  function eventsFromSteps(pitches,quantum,length,minSteps=1) {
    const events=[];
    let last=null,start=-1;
    function flush(step) {
      if(last==null||start<0 || step-start<minSteps)return;
      const s=clamp(Math.round(start/quantum)*quantum,0,length-1);
      const end=clamp(Math.max(s+1,Math.round(step/quantum)*quantum),s+1,length);
      if(events.length&&events[events.length-1].p===last&&events[events.length-1].s+events[events.length-1].d>=s-1){
        const prev=events[events.length-1];prev.d=Math.min(32,Math.max(prev.d,end-prev.s));
      }else{
        // Piano-roll pitch range (45..72) is the one currently supported by editor.
        const p=last>72?last-12:last<45?last+12:last;
        events.push({s,p:clamp(p,45,72),d:Math.min(32,end-s),v:.85});
      }
    }
    for(let i=0;i<=pitches.length;i++){
      const value=i<pitches.length?pitches[i]:null;
      if(value===last)continue;
      flush(i);last=value;start=value==null?-1:i;
    }
    return events.slice(0,1900);
  }
  async function arrange(buffer,config,report) {
    if(!buffer||typeof buffer.getChannelData!=="function")throw Error("Áudio inválido.");
    const signal=mono(buffer);
    if(signal.length<FFT)throw Error("Áudio muito curto.");
    const fallback=window.DarkwaveStudio?.settings?.().bpm||120;
    const count=Math.max(1,Math.floor(signal.length/HOP));
    const spectra=new Array(count);
    for(let i=0;i<count;i++){
      spectra[i]=fftMagnitude(signal,i*HOP-FFT/2);
      if(i%38===0){
        report(.03+.42*i/count,"Lendo o espectro do áudio e preservando sua dinâmica...");
        await yieldUI();
      }
    }
    const onsets=localSpectralOnsets(spectra);
    const bpm=config.tempo==="current"?fallback:detectTempo(onsets.peaks,fallback);
    const phase=findGridOffset(onsets.peaks,bpm);
    const timePerStep=60/bpm/4;
    const totalSteps=clamp(Math.ceil(buffer.duration/timePerStep),64,512);
    const activeSteps=Math.min(totalSteps,Math.ceil((signal.length/SR)/timePerStep));
    const tracks=blankTracks();
    const features=new Array(count);
    let globalMax=.001;
    for(let i=0;i<count;i++){
      features[i]=notesAtFrame(spectra,i);
      globalMax=Math.max(globalMax,features[i].max);
      if(i%38===0){
        report(.47+.30*i/count,"Identificando alturas, harmonias e continuidade...");
        await yieldUI();
      }
    }
    const avgSpectralBrightness={sum:0,count:0};
    const melodies=new Array(activeSteps).fill(null),basses=melodies.slice();
    const chords=Array.from({length:activeSteps},()=>[]);
    let lastMelody=null,lastBass=null;
    for(let step=0;step<activeSteps;step++){
      const centerTime=step*timePerStep+timePerStep*.49+phase;
      const central=clamp(Math.round(centerTime*SR/HOP),0,count-1);
      const pooled={score:new Float32Array(86),max:0};
      // Average several neighboring frames to reject isolated percussion/noise.
      let number=0;
      for(let frame=Math.max(0,central-1);frame<=Math.min(count-1,central+1);frame++){
        const f=features[frame];number++;
        for(let p=40;p<=84;p++)pooled.score[p]+=f.score[p];
      }
      for(let p=40;p<=84;p++){pooled.score[p]/=number;pooled.max=Math.max(pooled.max,pooled.score[p]);}
      if(pooled.max<globalMax*.08)continue;
      const bass=chooseMelody(pooled,40,56,lastBass,globalMax);
      const upper=chooseMelody(pooled,55,84,lastMelody,globalMax);
      const peakMelody=upper && pooled.score[upper]>pooled.max*.44?upper:null;
      const peakBass=bass && pooled.score[bass]>pooled.max*.45?bass:null;
      // Avoid hallucinating an octave bass from a strong upper note.
      const distinctBass=peakBass && peakMelody && peakMelody-peakBass===12 &&
        pooled.score[peakBass]<pooled.score[peakMelody]*.65?null:peakBass;
      melodies[step]=peakMelody;basses[step]=distinctBass;
      if(peakMelody!=null)lastMelody=peakMelody;
      if(distinctBass!=null)lastBass=distinctBass;
      if(config.complexity!=="melody"){
        const acceptable=[];
        for(let pitch=48;pitch<=77;pitch++){
          const val=pooled.score[pitch];
          if(val<pooled.max*(config.complexity==="rich"?.55:.68))continue;
          if(Math.abs(pitch-(peakMelody??999))<=2||Math.abs(pitch-(distinctBass??999))<=2)continue;
          acceptable.push({pitch,value:val});
        }
        acceptable.sort((a,b)=>b.value-a.value);
        for(const option of acceptable){
          if(chords[step].length>=(config.complexity==="rich"?3:2))break;
          if(chords[step].some(p=>Math.abs(option.pitch-p)<=2))continue;
          chords[step].push(option.pitch);
        }
      }
      // Spectral centroid estimates whether bright chip lead or softer keys fit better.
      const spectrum=spectra[central];let high=0,low=0;
      for(let b=50;b<900;b+=9){if(b>250)high+=spectrum[b];else low+=spectrum[b];}
      avgSpectralBrightness.sum+=high/(low+high+.000001);avgSpectralBrightness.count++;
    }
    // Reduce 1-step errors in note trajectories, then preserve larger rests.
    tracks[0]=eventsFromSteps(smooth(melodies),1,activeSteps);
    tracks[3]=eventsFromSteps(smooth(basses),1,activeSteps);
    if(config.complexity!=="melody"){
      const selectedPitches=new Set(chords.flat());
      for(const pitch of selectedPitches){
        const trackSeq=chords.map(x=>x.includes(pitch)?pitch:null);
        tracks[1].push(...eventsFromSteps(smooth(trackSeq),1,activeSteps,2));
      }
      // Only keep consistent chords, not hundreds of short false notes.
      tracks[1].sort((a,b)=>a.s-b.s||a.p-b.p);
      tracks[1]=tracks[1].slice(0,900);
      tracks[4]=tracks[1].filter(n=>n.d>=5).map(n=>({...n,d:Math.min(16,n.d)}));
    }
    // Percussive onsets use changes in the actual spectral content, not fabricated beats.
    const usedKick=new Set(),usedHat=new Set();
    const strengths=onsets.peaks.map(p=>p.strength);
    // Eliminate tiny "onsets" due to FFT phase leakage in stable sustained notes.
    const onsetStrength=Math.max(percentile(strengths,.8)*.085,percentile(strengths,.35)*2.1);
    const reliableOnsets=onsets.peaks.filter(p=>p.strength>=onsetStrength);
    for(const hit of reliableOnsets.length>=3?reliableOnsets:[]){
      const step=Math.round((hit.time-phase)/timePerStep);
      if(step<0||step>=activeSteps||hit.strength<onsetStrength)continue;
      if(hit.low>hit.high*.72 && hit.low>.02) {
        if(!usedKick.has(step)){
          tracks[6].push({s:step,p:48,d:1,v:.85});usedKick.add(step);
        }
      }else if(!usedHat.has(step)){
        tracks[7].push({s:step,p:60,d:1,v:.85});usedHat.add(step);
      }
    }
    const brightness=avgSpectralBrightness.sum/Math.max(1,avgSpectralBrightness.count);
    const instruments=[
      brightness>.59?"pulse":brightness>.43?"lead":"electric",
      "keys",
      "celesta",
      "subbass",
      "strings",
      "pluck",
      "kick",
      "snare"
    ];
    const total=tracks.reduce((n,x)=>n+x.length,0);
    if(total<2)throw Error("A análise não identificou notas suficientes. Uma melodia isolada ou áudio mais limpo ajudará.");
    report(1,"Notas analisadas. Compare com o áudio original e ajuste os instrumentos.");
    return {
      title:"Arranjo — "+String(config.title||"Áudio"),
      bpm,
      totalSteps,
      tracks,
      instruments,
      analysis:{notes:total,brightness,onsets:onsets.peaks.length,estimatedBpm:bpm,mode:"spectral-v3",preserveOriginal:true}
    };
  }
  window.DarkwaveAnalyzerV3={arrange};
})();