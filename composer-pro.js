"use strict";
/* Composer Pro: original motif ideas and standard MIDI 1.0 file exchange. */
(function(){
  const $=id=>document.getElementById(id);
  const app=()=>window.DarkwaveStudio;
  const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
  const mod=(x,n)=>((x%n)+n)%n;
  const note=(s,p,d=2,v=.8)=>({s,p:clamp(p,45,72),d,v});
  const notify=s=>app().notify(s);
  const keys={major:[0,2,4,5,7,9,11],minor:[0,2,3,5,7,8,10],pentatonic:[0,2,4,7,9],chromatic:[0,1,2,3,4,5,6,7,8,9,10,11]};
  function setup(){
    $("harmonyBtn").addEventListener("click",()=>createHarmony("chords"));
    $("basslineBtn").addEventListener("click",()=>createHarmony("bass"));
    $("arpBtn").addEventListener("click",()=>createHarmony("arp"));
    $("variationBtn").addEventListener("click",createVariation);
    $("midiExportBtn").addEventListener("click",exportMIDI);
    $("midiImportBtn").addEventListener("click",()=>$("midiInput").click());
    $("midiInput").addEventListener("change",async e=>{
      try{
        if(!e.target.files[0])return;
        if(e.target.files[0].size>3*1024*1024)throw Error("Use arquivos MIDI de até 3 MB.");
        const parsed=decodeMIDI(await e.target.files[0].arrayBuffer());
        app().applyProject(parsed,"MIDI importado com notas e BPM editáveis. Os timbres General MIDI foram aproximados.");
      }catch(err){notify("Erro ao importar MIDI: "+err.message);}
      finally{e.target.value="";}
    });
    document.addEventListener("keydown",e=>{
      if(!(e.ctrlKey||e.metaKey) || !window.DarkwaveStudio)return;
      if(e.target.closest("input,textarea,select") || e.altKey)return;
      // MIDI export is deliberately explicit via the button.
    });
  }
  function selectedKey(){
    const root=Number($("scaleRoot").value)||0;
    const mode=$("scaleMode").value;
    return {root,steps:keys[mode]||keys.major,mode};
  }
  function progression(){
    const kind=$("harmonyProgression").value;
    if(kind==="emotional")return [5,3,0,4];
    if(kind==="mysterious")return [0,5,2,6];
    if(kind==="tension")return [0,3,4,0];
    return [0,4,5,3];
  }
  function scaleDegrees(){
    const key=selectedKey();
    const scale=key.steps.length===7?key.steps:(key.mode==="pentatonic"?keys.major:keys.minor);
    return {scale,root:key.root};
  }
  function voicePitch(semitones,octave=4){
    let p=12*(octave+1)+mod(semitones,12);
    while(p>72)p-=12;
    while(p<45)p+=12;
    return p;
  }
  function toneAtDegree(degree,octave){
    const {scale,root}=scaleDegrees();
    const oct=Math.floor(degree/7);
    return voicePitch(root+scale[mod(degree,7)]+12*oct,octave);
  }
  function projectBarsOrReject(start){
    const project=app().getProject();
    if(start<0||start+4>project.bars){
      notify("Escolha um compasso inicial que deixe espaço para quatro compassos.");
      return null;
    }
    return project;
  }
  function addUnique(list,source){
    for(const n of source){
      if(n.s<0 || n.s>=512)continue;
      if(!list.some(x=>x.s===n.s && x.p===n.p))
        list.push({...n,d:Math.max(1,Math.min(n.d,32))});
    }
  }
  function createHarmony(type){
    const bar=clamp(Number($("assistantStartBar").value)||1,1,32)-1;
    const project=projectBarsOrReject(bar);
    if(!project)return;
    const degrees=progression();
    const target=type==="chords"?1:type==="bass"?3:5;
    const additions=[];
    for(let measure=0;measure<4;measure++){
      const start=(bar+measure)*16,degree=degrees[measure];
      if(type==="chords"){
        const [a,b,c]=[0,2,4].map(diff=>toneAtDegree(degree+diff,3));
        addUnique(additions,[note(start,a,14,.65),note(start,b,14,.64),note(start,c,14,.62)]);
      }else if(type==="bass"){
        const root=toneAtDegree(degree,3);
        addUnique(additions,[note(start,root,6,.85),note(start+8,root,4,.73),note(start+12,toneAtDegree(degree+4,3),4,.72)]);
      }else{
        const pitches=[0,2,4,2,0,2,4,2].map(x=>toneAtDegree(degree+x,4));
        for(let i=0;i<8;i++)addUnique(additions,[note(start+i*2,pitches[i],2,.69)]);
      }
    }
    if(!additions.length){notify("Nada a adicionar.");return;}
    addUnique(project.tracks[target].notes,additions);
    if(type==="chords")project.tracks[target].instrument="electric";
    if(type==="bass")project.tracks[target].instrument="subbass";
    if(type==="arp")project.tracks[target].instrument="arp8";
    app().applyProject(project,{chords:"Acordes originais adicionados.",bass:"Linha de baixo original adicionada.",arp:"Arpejo original adicionado."}[type]);
  }
  function createVariation(){
    const project=app().getProject(),i=app().getSelectedTrack();
    const startBar=clamp(Number($("assistantStartBar").value)||1,1,32)-1;
    if(startBar+2>project.bars){notify("Precisa de pelo menos dois compassos.");return;}
    const source=project.tracks[i].notes.filter(n=>n.s>=startBar*16 && n.s<(startBar+1)*16).sort((a,b)=>a.s-b.s);
    if(!source.length){notify("Crie algumas notas neste compasso para gerar uma variação.");return;}
    const shift=16;
    const target=source.map((n,j)=>{
      const semitone=(j%3===0?2:j%3===1?-2:0);
      const p=clamp(n.p+semitone,45,72);
      return note(n.s+shift,p,Math.min(n.d,16-(n.s%16)),n.v??.8);
    });
    addUnique(project.tracks[i].notes,target);
    app().applyProject(project,"Variação do motivo criada no próximo compasso.");
  }

  // Standard MIDI file codec; no network, CDN or third-party dependencies.
  const BE16=x=>[(x>>8)&255,x&255];
  const BE32=x=>[(x>>>24)&255,(x>>>16)&255,(x>>>8)&255,x&255];
  const vlq=value=>{
    value=Math.max(0,Math.floor(value));const out=[value&127];
    while((value>>=7)>0)out.unshift((value&127)|128);
    return out;
  };
  function chunk(name,data){
    return [...name].map(x=>x.charCodeAt(0)).concat(BE32(data.length),data);
  }
  function gmProgram(type){
    const m={lead:80,pulse:80,triangle:80,arp8:81,glitch:98,keys:1,electric:2,organ:19,celesta:8,bell:9,marimba:12,chime:14,pluck:10,harp:46,bass:38,subbass:38,acid:39,pad:89,strings:48,choir:52,brass:61,flute:73,kick:0,hat:0,snare:0,tom:0};
    return m[type]??0;
  }
  function encodeMIDI(project){
    const division=480,events=[];
    const microseconds=clamp(Math.round(60000000/(project.bpm||120)),250000,1200000);
    const tempo=[0,255,81,3,(microseconds>>16)&255,(microseconds>>8)&255,microseconds&255];
    const signature=[0,255,88,4,4,2,24,8];
    const headTrack=[...tempo,...signature,0,255,47,0];
    const parts=[chunk("MTrk",headTrack)];
    for(let tr=0;tr<8;tr++){
      const track=project.tracks[tr]||{notes:[],instrument:"lead"};
      const channel=tr>=6?9:tr;const arr=[];
      arr.push({at:0,order:0,bytes:[0xC0|channel,gmProgram(track.instrument)]});
      for(const n of track.notes||[]){
        if(!Number.isFinite(n.s)||!Number.isFinite(n.p)||!Number.isFinite(n.d))continue;
        const pitch=tr===6?36:tr===7?42:clamp(Math.round(n.p),0,127);
        const velocity=clamp(Math.round((n.v??.85)*110),1,127);
        const begin=Math.round(n.s*division/4);
        const end=begin+Math.max(1,Math.round(n.d*division/4));
        arr.push({at:begin,order:2,bytes:[0x90|channel,pitch,velocity]});
        arr.push({at:end,order:1,bytes:[0x80|channel,pitch,0]});
      }
      arr.sort((a,b)=>a.at-b.at || a.order-b.order);
      let last=0,bytes=[];
      for(const entry of arr){
        bytes.push(...vlq(entry.at-last),...entry.bytes);
        last=entry.at;
      }
      bytes.push(0,255,47,0);
      parts.push(chunk("MTrk",bytes));
    }
    const header=chunk("MThd",[0,1,0,9,...BE16(division)]);
    return new Uint8Array([...header,...parts.flat()]);
  }
  function exportMIDI(){
    try{
      const project=app().getProject();
      const bytes=encodeMIDI(project);
      const name=(project.title||"trilha").normalize("NFD").replace(/[\u0300-\u036f]/g,"").replace(/[^a-z0-9-_]+/gi,"_");
      app().saveFile(new Blob([bytes],{type:"audio/midi"}),name+".mid");
      notify("MIDI exportado! Notas, intensidade, tempo e faixas incluídos.");
    }catch(e){notify("Erro no MIDI: "+e.message);}
  }
  function decodeMIDI(binary){
    const data=new DataView(binary),bytes=new Uint8Array(binary);
    if(bytes.length<14||String.fromCharCode(...bytes.slice(0,4))!=="MThd")throw Error("Cabeçalho MIDI não encontrado.");
    const headerLen=data.getUint32(4,false),tracksCount=data.getUint16(10,false),division=data.getUint16(12,false);
    if(headerLen<6||division&0x8000)throw Error("Formato MIDI SMPTE não suportado.");
    if(tracksCount>128)throw Error("Número de trilhas inválido.");
    let position=8+headerLen,tempo=500000;const all=[];
    for(let ti=0;ti<tracksCount;ti++){
      if(position+8>bytes.length)throw Error("Arquivo MIDI incompleto.");
      if(String.fromCharCode(...bytes.slice(position,position+4))!=="MTrk")throw Error("Chunk MTrk inválido.");
      const len=data.getUint32(position+4,false);
      position+=8;const end=position+len;
      if(end>bytes.length)throw Error("Fim de faixa inválido.");
      let tick=0,running=0;const sounding=new Map(),notes=[];
      const varLen=()=>{
        let x=0,b,i=0;
        do{
          if(position>=end||i++>=5)throw Error("Delta MIDI inválido.");
          b=bytes[position++];x=(x<<7)|(b&127);
        }while(b&128);
        return x;
      };
      while(position<end){
        tick+=varLen();
        if(position>=end)break;
        let status=bytes[position];
        if(status<128){
          if(!running)throw Error("Running status inválido.");
          status=running;
        }else{
          position++;
          if(status<240)running=status;
          else running=0;
        }
        if(status===255){
          const kind=bytes[position++],size=varLen();
          if(position+size>end)throw Error("Meta evento inválido.");
          if(kind===0x51&&size===3&&tick===0)tempo=(bytes[position]<<16)|(bytes[position+1]<<8)|bytes[position+2];
          position+=size;
          continue;
        }
        if(status===0xF0||status===0xF7){const size=varLen();position+=size;if(position>end)throw Error("SysEx inválido.");continue;}
        const type=status&0xf0,channel=status&0xf;
        if(type<0x80||type>0xE0)throw Error("Evento MIDI não suportado.");
        const arg1=bytes[position++],arg2=(type===0xC0||type===0xD0)?0:bytes[position++];
        if(position>end)throw Error("Dados de evento incompletos.");
        if(type===0x90&&arg2>0){
          const key=channel+":"+arg1;
          if(!sounding.has(key))sounding.set(key,[]);
          sounding.get(key).push({tick,channel,pitch:arg1,velocity:arg2});
        } else if(type===0x80 || (type===0x90&&arg2===0)){
          const key=channel+":"+arg1,stack=sounding.get(key);
          if(stack?.length){
            const event=stack.shift();
            notes.push({...event,end:tick});
          }
        }
      }
      position=end;
      if(notes.length)all.push(notes);
    }
    const bpm=clamp(Math.round(60000000/Math.max(1,tempo)),50,240);
    const project={
      version:2,title:"MIDI importado",bpm,bars:32,swing:0,volume:75,
      tracks:Array.from({length:8},(_,i)=>({notes:[],muted:false,solo:false,volume:100,instrument:["lead","keys","bell","subbass","strings","arp8","kick","hat"][i]}))
    };
    let maxStep=0,melodic=0;
    for(const notes of all){
      const normal=notes.filter(n=>n.channel!==9);
      const target=normal.length?Math.min(5,melodic++):6;
      for(const n of notes.slice(0,8000)){
        const index=n.channel===9?(n.pitch===42||n.pitch===44||n.pitch===46?7:6):target;
        let pitch=n.channel===9?(index===7?60:48):n.pitch;
        while(pitch<45)pitch+=12;
        while(pitch>72)pitch-=12;
        const start=Math.max(0,Math.round(n.tick/division*4));
        const duration=Math.max(1,Math.round((n.end-n.tick)/division*4));
        if(start>=512)continue;
        project.tracks[index].notes.push(note(start,pitch,Math.min(32,duration,512-start),clamp(n.velocity/127,.1,1)));
        maxStep=Math.max(maxStep,start+duration);
      }
    }
    if(project.tracks.every(x=>!x.notes.length))throw Error("Não encontrei eventos de notas no arquivo.");
    project.bars=[4,8,16,32].find(b=>b*16>=maxStep)||32;
    return project;
  }
  window.DarkwaveComposerPro={encodeMIDI,decodeMIDI,createHarmony,createVariation};
  setup();
})();
