
import React, { useState, useRef, useCallback, useEffect } from 'react';
import { GoogleGenAI, Modality, Type, FunctionDeclaration, LiveServerMessage } from '@google/genai';
import { decode, decodeAudioData, createPcmBlob } from './utils/audio-helpers';
import { TranscriptionPart, ClickAction, SessionStatus } from './types';

const FRAME_RATE = 2.0; // Increased for better responsiveness
const JPEG_QUALITY = 0.5;
const AUDIO_SAMPLE_RATE = 24000;
const INPUT_SAMPLE_RATE = 16000;

const clickAnswerDeclaration: FunctionDeclaration = {
  name: 'click_answer',
  parameters: {
    type: Type.OBJECT,
    description: 'Autonomous interaction: Highlight or "click" a specific answer or UI element visible on the screen.',
    properties: {
      x: {
        type: Type.NUMBER,
        description: 'The horizontal coordinate (0-100) relative to screen width.',
      },
      y: {
        type: Type.NUMBER,
        description: 'The vertical coordinate (0-100) relative to screen height.',
      },
      label: {
        type: Type.STRING,
        description: 'A text label describing the answer being clicked.',
      },
    },
    required: ['x', 'y', 'label'],
  },
};

export default function App() {
  const [status, setStatus] = useState<SessionStatus>(SessionStatus.IDLE);
  const [error, setError] = useState<string | null>(null);
  const [transcriptions, setTranscriptions] = useState<TranscriptionPart[]>([]);
  const [isScreenShared, setIsScreenShared] = useState(false);
  const [clicks, setClicks] = useState<ClickAction[]>([]);
  const [isAiSpeaking, setIsAiSpeaking] = useState(false);
  const [viewMode, setViewMode] = useState<'raw' | 'ai'>('ai'); // Default to AI feed to verify it works
  const [isCapturing, setIsCapturing] = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const screenStreamRef = useRef<MediaStream | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const activeSessionRef = useRef<any>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const outputAudioContextRef = useRef<AudioContext | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const frameIntervalRef = useRef<number | null>(null);

  const addTranscription = useCallback((text: string, sender: 'user' | 'model') => {
    setTranscriptions(prev => [...prev.slice(-20), { text, sender, timestamp: Date.now() }]);
  }, []);

  const handleStop = useCallback(() => {
    if (frameIntervalRef.current) {
      window.clearInterval(frameIntervalRef.current);
      frameIntervalRef.current = null;
    }
    if (activeSessionRef.current) {
      activeSessionRef.current.close();
      activeSessionRef.current = null;
    }
    if (screenStreamRef.current) {
      screenStreamRef.current.getTracks().forEach(t => t.stop());
      screenStreamRef.current = null;
    }
    if (micStreamRef.current) {
      micStreamRef.current.getTracks().forEach(t => t.stop());
      micStreamRef.current = null;
    }
    
    sourcesRef.current.forEach(s => {
      try { s.stop(); } catch (e) {}
    });
    sourcesRef.current.clear();
    
    setStatus(SessionStatus.IDLE);
    setIsScreenShared(false);
    setIsAiSpeaking(false);
    setIsCapturing(false);
    nextStartTimeRef.current = 0;
  }, []);

  const blobToBase64 = (blob: Blob): Promise<string> => {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve((reader.result as string).split(',')[1]);
      reader.readAsDataURL(blob);
    });
  };

  const startScreenShare = async () => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { cursor: "always" } as any,
        audio: false
      });
      screenStreamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        // CRITICAL: Must ensure video plays to avoid black frames
        videoRef.current.onloadedmetadata = () => {
          videoRef.current?.play().catch(console.error);
        };
      }
      setIsScreenShared(true);
      stream.getVideoTracks()[0].onended = () => handleStop();
    } catch (err: any) {
      setError("Screen sharing denied or failed. Please allow access to your screen.");
    }
  };

  const startAISession = async () => {
    if (!process.env.API_KEY) {
      setError("API Key is missing from the environment.");
      return;
    }

    setStatus(SessionStatus.CONNECTING);
    setError(null);

    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      
      if (!outputAudioContextRef.current) {
        outputAudioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: AUDIO_SAMPLE_RATE });
      }
      if (outputAudioContextRef.current.state === 'suspended') await outputAudioContextRef.current.resume();

      const micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      micStreamRef.current = micStream;
      
      if (!audioContextRef.current) {
        audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: INPUT_SAMPLE_RATE });
      }
      if (audioContextRef.current.state === 'suspended') await audioContextRef.current.resume();

      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-09-2025',
        config: {
          responseModalities: [Modality.AUDIO],
          systemInstruction: 'You are a live AI Screen Reader and Interaction Agent. You have a constant video feed of the user screen capture. Your PRIMARY function is to look at this visual feed and answer questions about it. YOU CAN SEE THE SCREEN. If you see text, UI elements, or images, describe them if asked. Use the "click_answer" tool to highlight elements on the screen. If the screen appears static, continue watching for changes. Always assume you can see the screen unless it is literally black.',
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Puck' } }
          },
          tools: [{ functionDeclarations: [clickAnswerDeclaration] }],
          inputAudioTranscription: {},
          outputAudioTranscription: {},
        },
        callbacks: {
          onopen: () => {
            setStatus(SessionStatus.ACTIVE);
            setIsCapturing(true);
            
            // MIC STREAMING
            const source = audioContextRef.current!.createMediaStreamSource(micStream);
            const scriptProcessor = audioContextRef.current!.createScriptProcessor(4096, 1, 1);
            scriptProcessor.onaudioprocess = (e) => {
              const inputData = e.inputBuffer.getChannelData(0);
              const pcmData = createPcmBlob(inputData);
              sessionPromise.then(session => session.sendRealtimeInput({ media: { data: pcmData, mimeType: 'audio/pcm;rate=16000' } })).catch(() => {});
            };
            source.connect(scriptProcessor);
            const silentGain = audioContextRef.current!.createGain();
            silentGain.gain.value = 0;
            scriptProcessor.connect(silentGain);
            silentGain.connect(audioContextRef.current!.destination);

            // SCREEN CAPTURE LOOP
            frameIntervalRef.current = window.setInterval(() => {
              const video = videoRef.current;
              const canvas = canvasRef.current;
              if (canvas && video && video.readyState >= 2 && video.videoWidth > 0) {
                const ctx = canvas.getContext('2d');
                if (ctx) {
                  // Standard resolution for vision tasks to avoid overwhelming bandwidth but maintain clarity
                  const targetWidth = 1024;
                  const targetHeight = (video.videoHeight / video.videoWidth) * targetWidth;
                  canvas.width = targetWidth;
                  canvas.height = targetHeight;
                  
                  ctx.drawImage(video, 0, 0, targetWidth, targetHeight);
                  
                  canvas.toBlob(async (blob) => {
                    if (blob) {
                      const base64Data = await blobToBase64(blob);
                      sessionPromise.then(session => {
                        session.sendRealtimeInput({
                          media: { data: base64Data, mimeType: 'image/jpeg' }
                        });
                      }).catch(() => {});
                    }
                  }, 'image/jpeg', JPEG_QUALITY);
                }
              }
            }, 1000 / FRAME_RATE);
          },
          onmessage: async (message: LiveServerMessage) => {
            if (message.serverContent?.outputTranscription) {
              addTranscription(message.serverContent.outputTranscription.text, 'model');
            } else if (message.serverContent?.inputTranscription) {
              addTranscription(message.serverContent.inputTranscription.text, 'user');
            }

            const audioData = message.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
            if (audioData && outputAudioContextRef.current) {
              setIsAiSpeaking(true);
              const ctx = outputAudioContextRef.current;
              nextStartTimeRef.current = Math.max(nextStartTimeRef.current, ctx.currentTime);
              const audioBuffer = await decodeAudioData(decode(audioData), ctx, AUDIO_SAMPLE_RATE, 1);
              const source = ctx.createBufferSource();
              source.buffer = audioBuffer;
              source.connect(ctx.destination);
              source.onended = () => {
                sourcesRef.current.delete(source);
                if (sourcesRef.current.size === 0) setIsAiSpeaking(false);
              };
              source.start(nextStartTimeRef.current);
              nextStartTimeRef.current += audioBuffer.duration;
              sourcesRef.current.add(source);
            }

            if (message.serverContent?.interrupted) {
              sourcesRef.current.forEach(s => { try { s.stop(); } catch (e) {} });
              sourcesRef.current.clear();
              nextStartTimeRef.current = 0;
              setIsAiSpeaking(false);
            }

            if (message.toolCall) {
              for (const fc of message.toolCall.functionCalls) {
                if (fc.name === 'click_answer') {
                  const args = fc.args as any;
                  const id = Math.random().toString(36).substr(2, 9);
                  setClicks(prev => [...prev, { x: args.x, y: args.y, label: args.label, id }]);
                  setTimeout(() => setClicks(prev => prev.filter(c => c.id !== id)), 4000);
                  sessionPromise.then(session => session.sendToolResponse({
                    functionResponses: [{ id: fc.id, name: fc.name, response: { result: "ok" } }]
                  })).catch(console.error);
                }
              }
            }
          },
          onerror: (e) => {
            console.error("Live Error:", e);
            setError("Connection issue detected. Re-syncing...");
            handleStop();
          },
          onclose: () => handleStop()
        }
      });
      activeSessionRef.current = await sessionPromise;
    } catch (err: any) {
      setError(err.message || "Failed to start AI session.");
      setStatus(SessionStatus.IDLE);
    }
  };

  return (
    <div className="flex flex-col h-screen bg-slate-950 text-slate-200">
      {/* Dynamic Background */}
      <div className="fixed inset-0 pointer-events-none overflow-hidden opacity-30">
        <div className="absolute -top-[10%] -left-[10%] w-[50%] h-[50%] bg-cyan-900/20 blur-[120px] rounded-full animate-pulse" />
        <div className="absolute -bottom-[10%] -right-[10%] w-[50%] h-[50%] bg-indigo-900/20 blur-[120px] rounded-full animate-pulse" style={{ animationDelay: '1s' }} />
      </div>

      <header className="relative z-10 flex flex-wrap items-center justify-between gap-4 p-4 bg-slate-900/80 backdrop-blur-md border-b border-slate-800 shadow-2xl">
        <div className="flex items-center gap-4">
          <div className="group relative">
            <div className="absolute -inset-1 bg-gradient-to-r from-cyan-400 to-indigo-500 rounded-xl blur opacity-25 group-hover:opacity-50 transition duration-1000"></div>
            <div className="relative w-12 h-12 bg-slate-900 rounded-xl flex items-center justify-center border border-slate-700">
              <svg className="w-7 h-7 text-cyan-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
              </svg>
            </div>
          </div>
          <div>
            <h1 className="text-xl font-black text-white tracking-tighter uppercase italic">OmniVision AI</h1>
            <div className="flex items-center gap-2">
               <div className={`w-2 h-2 rounded-full ${status === SessionStatus.ACTIVE ? 'bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.8)]' : 'bg-slate-700'}`} />
               <span className="text-[10px] text-slate-400 font-black uppercase tracking-widest">{status}</span>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2 p-1 bg-slate-800/80 rounded-2xl border border-slate-700/50 shadow-inner">
          {!isScreenShared ? (
            <button 
              onClick={startScreenShare}
              className="px-6 py-3 bg-gradient-to-br from-cyan-600 to-cyan-700 hover:from-cyan-500 hover:to-cyan-600 text-white text-sm font-black rounded-xl transition-all flex items-center gap-3 shadow-lg active:scale-95 uppercase tracking-tighter"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" /></svg>
              Share My Screen
            </button>
          ) : (
            <>
              <button 
                onClick={status === SessionStatus.IDLE ? startAISession : handleStop}
                className={`px-6 py-3 text-white text-sm font-black rounded-xl transition-all flex items-center gap-3 shadow-lg active:scale-95 uppercase tracking-tighter ${status === SessionStatus.IDLE ? 'bg-gradient-to-br from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500' : 'bg-gradient-to-br from-rose-600 to-pink-600 hover:from-rose-500 hover:to-pink-500'}`}
              >
                {status === SessionStatus.IDLE ? (
                  <>
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>
                    Start Analysis
                  </>
                ) : (
                  <>
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                    Stop AI
                  </>
                )}
              </button>
              
              <div className="w-px h-8 bg-slate-700/50 mx-1" />

              <button 
                onClick={() => setViewMode(viewMode === 'raw' ? 'ai' : 'raw')}
                className={`px-4 py-3 rounded-xl text-sm font-black transition-all flex items-center gap-3 uppercase tracking-tighter ${viewMode === 'ai' ? 'bg-cyan-500/20 text-cyan-400 border border-cyan-500/30' : 'bg-slate-700 text-slate-400 hover:bg-slate-600 hover:text-white'}`}
                title="Switch View Mode"
              >
                {viewMode === 'ai' ? (
                   <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20"><path d="M10 12a2 2 0 100-4 2 2 0 000 4z" /><path fillRule="evenodd" d="M.458 10C1.732 5.943 5.522 3 10 3s8.268 2.943 9.542 7c-1.274 4.057-5.064 7-9.542 7S1.732 14.057.458 10zM14 10a4 4 0 11-8 0 4 4 0 018 0z" clipRule="evenodd" /></svg>
                ) : (
                   <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" /></svg>
                )}
                {viewMode === 'ai' ? 'AI Vision On' : 'View AI Feed'}
              </button>
            </>
          )}
        </div>
      </header>

      <main className="relative z-10 flex-1 flex flex-col lg:flex-row gap-6 p-6 overflow-hidden">
        {/* Main Observation Deck */}
        <div className="flex-1 flex flex-col gap-6 relative min-h-0">
          <div className="flex-1 bg-black rounded-[2.5rem] overflow-hidden relative border border-slate-800 shadow-[0_0_50px_rgba(0,0,0,0.5)] ring-1 ring-white/10 group">
            {!isScreenShared ? (
              <div className="absolute inset-0 flex flex-col items-center justify-center p-12 text-center">
                <div className="w-32 h-32 bg-slate-900 rounded-full flex items-center justify-center border-4 border-slate-800 mb-8 animate-pulse">
                  <svg className="w-14 h-14 text-slate-700" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.75 17L9 21h6l-.75-4M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                  </svg>
                </div>
                <h3 className="text-3xl font-black text-white mb-4 tracking-tighter">AWAITING FEED</h3>
                <p className="text-slate-500 max-w-sm font-medium">Click "Share My Screen" so the AI can analyze your view in real-time.</p>
              </div>
            ) : (
              <div className="w-full h-full flex items-center justify-center bg-slate-950 relative">
                {/* Mode: Raw Video */}
                <video 
                  ref={videoRef} 
                  autoPlay 
                  playsInline 
                  muted 
                  className={`w-full h-full object-contain ${viewMode === 'ai' ? 'hidden' : 'block'}`}
                />

                {/* Mode: AI Vision Feed (Directly what is sent to Gemini) */}
                <div className={`w-full h-full relative ${viewMode === 'ai' ? 'block' : 'hidden'}`}>
                  <canvas 
                    ref={canvasRef} 
                    className="w-full h-full object-contain opacity-100 transition-all duration-300 filter brightness-110 contrast-125 saturate-150" 
                  />
                  {/* Digital HUD Overlay */}
                  <div className="absolute inset-0 pointer-events-none select-none">
                    <div className="absolute top-0 left-0 right-0 h-px bg-cyan-400 shadow-[0_0_20px_cyan] animate-scan-line opacity-50" />
                    <div className="absolute inset-0 border-[20px] border-slate-950/20" />
                    {/* Corner accents */}
                    <div className="absolute top-8 left-8 w-12 h-12 border-t-4 border-l-4 border-cyan-500 rounded-tl-lg" />
                    <div className="absolute top-8 right-8 w-12 h-12 border-t-4 border-r-4 border-cyan-500 rounded-tr-lg" />
                    <div className="absolute bottom-8 left-8 w-12 h-12 border-b-4 border-l-4 border-cyan-500 rounded-bl-lg" />
                    <div className="absolute bottom-8 right-8 w-12 h-12 border-b-4 border-r-4 border-cyan-500 rounded-br-lg" />
                    
                    <div className="absolute bottom-10 left-10 flex flex-col gap-2">
                       <div className="px-4 py-2 bg-black/80 backdrop-blur-xl border border-cyan-500/30 rounded-lg flex items-center gap-3">
                          <div className="w-2.5 h-2.5 bg-red-600 rounded-full animate-pulse" />
                          <span className="text-[10px] font-black text-cyan-400 uppercase tracking-[0.2em]">Live Processed Uplink • {FRAME_RATE} Hz</span>
                       </div>
                       <div className="text-[8px] font-bold text-slate-500 uppercase tracking-widest pl-1">
                          Analyzing Pixels... Correcting Matrix...
                       </div>
                    </div>
                  </div>
                </div>

                {/* Click / Target Markers */}
                {clicks.map(click => (
                  <div 
                    key={click.id}
                    className="absolute transform -translate-x-1/2 -translate-y-1/2 pointer-events-none z-[60]"
                    style={{ left: `${click.x}%`, top: `${click.y}%` }}
                  >
                    <div className="relative">
                      <div className="w-16 h-16 border-2 border-cyan-400 rounded-full animate-[ping_2s_infinite] opacity-60" />
                      <div className="absolute inset-0 flex items-center justify-center">
                        <div className="w-6 h-6 bg-cyan-500 rounded-full shadow-[0_0_30px_cyan] flex items-center justify-center">
                           <div className="w-1.5 h-1.5 bg-white rounded-full" />
                        </div>
                      </div>
                      <div className="absolute top-16 left-1/2 -translate-x-1/2 bg-slate-900/95 backdrop-blur-xl border border-cyan-500/50 px-4 py-2 rounded-xl shadow-2xl scale-in-center">
                         <span className="text-[10px] font-black text-white uppercase tracking-tighter whitespace-nowrap">
                           AI TARGET: {click.label}
                         </span>
                      </div>
                    </div>
                  </div>
                ))}

                {/* Voice Interaction HUD */}
                {isAiSpeaking && (
                  <div className="absolute top-10 left-1/2 -translate-x-1/2 flex items-center gap-6 px-8 py-4 bg-slate-900/90 backdrop-blur-2xl border border-white/10 rounded-full shadow-[0_20px_50px_rgba(0,0,0,0.5)] z-[100] animate-in slide-in-from-top-6">
                    <div className="flex items-end gap-1.5 h-6">
                      {[1, 2, 3, 4, 5, 6, 7, 8].map(i => (
                        <div 
                          key={i} 
                          className="w-1.5 bg-gradient-to-t from-cyan-600 to-indigo-400 rounded-full animate-bounce-custom" 
                          style={{ animationDelay: `${i * 0.08}s`, height: `${30 + Math.random() * 70}%` }} 
                        />
                      ))}
                    </div>
                    <div className="flex flex-col">
                       <span className="text-xs font-black text-white uppercase tracking-[0.2em] leading-none mb-1">AI Transmitting</span>
                       <span className="text-[9px] font-bold text-slate-500 uppercase tracking-widest leading-none">Voice Synthesis Active</span>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {error && (
            <div className="p-4 bg-rose-950/40 border border-rose-500/30 text-rose-300 text-xs font-black uppercase tracking-widest rounded-2xl flex items-center gap-4 animate-in slide-in-from-bottom-4">
              <div className="w-8 h-8 bg-rose-500/20 rounded-lg flex items-center justify-center text-rose-400">
                 <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
              </div>
              {error}
            </div>
          )}
        </div>

        {/* Transmission Intelligence Log */}
        <div className="lg:w-96 flex flex-col bg-slate-900/50 backdrop-blur-md border border-slate-800 rounded-[2.5rem] overflow-hidden shadow-2xl ring-1 ring-white/5">
          <div className="p-6 border-b border-slate-800 flex items-center justify-between">
            <div>
              <h2 className="text-xs font-black text-slate-500 uppercase tracking-[0.3em] mb-1">Observation Log</h2>
              <p className="text-[10px] text-slate-600 font-bold uppercase tracking-widest">Real-time Telemetry</p>
            </div>
            <div className={`flex items-center gap-2 px-3 py-1 bg-slate-800 rounded-lg border border-slate-700`}>
              <div className={`w-1.5 h-1.5 rounded-full ${isCapturing ? 'bg-emerald-500 animate-pulse shadow-[0_0_5px_emerald]' : 'bg-slate-600'}`} />
              <span className="text-[8px] font-black text-slate-400 uppercase">Input</span>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto p-6 space-y-6 custom-scrollbar">
            {transcriptions.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center opacity-20 text-center">
                <div className="w-16 h-16 mb-6 border-2 border-dashed border-slate-600 rounded-full flex items-center justify-center">
                   <svg className="w-8 h-8 text-slate-500" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M18 10c0 3.866-3.582 7-8 7a8.841 8.841 0 01-4.083-.98L2 17l1.338-3.123C2.493 12.767 2 11.434 2 10c0-3.866 3.582-7 8-7s8 3.134 8 7z" clipRule="evenodd" /></svg>
                </div>
                <p className="text-[10px] font-black uppercase tracking-[0.2em] max-w-[150px]">Standing by for verbal data transmission</p>
              </div>
            ) : (
              transcriptions.map((t, i) => (
                <div key={i} className={`flex flex-col ${t.sender === 'user' ? 'items-end' : 'items-start'} animate-in slide-in-from-bottom-2`}>
                  <div className={`text-[8px] font-black uppercase tracking-[0.2em] mb-1.5 opacity-40 px-2`}>
                     {t.sender === 'user' ? 'LOCAL USER' : 'CORE AI'}
                  </div>
                  <div className={`max-w-[90%] px-5 py-3 rounded-2xl text-[13px] font-medium leading-relaxed shadow-lg ${
                    t.sender === 'user' 
                      ? 'bg-slate-800 text-slate-200 rounded-tr-none border border-white/5' 
                      : 'bg-cyan-500/10 text-cyan-200 rounded-tl-none border border-cyan-500/20'
                  }`}>
                    {t.text}
                  </div>
                </div>
              ))
            )}
          </div>

          <div className="p-6 bg-slate-900/80 border-t border-slate-800">
            <div className="space-y-4">
              <div className="flex justify-between items-center text-[9px] font-black text-slate-500 uppercase tracking-widest">
                <span>Signal Integrity</span>
                <span>{status === SessionStatus.ACTIVE ? '99.8%' : '0.0%'}</span>
              </div>
              <div className="h-2 bg-slate-800 rounded-full overflow-hidden p-0.5 border border-slate-700/50">
                <div 
                  className={`h-full transition-all duration-1000 ease-out rounded-full ${status === SessionStatus.ACTIVE ? 'w-full bg-gradient-to-r from-cyan-600 to-indigo-500' : 'w-0'}`} 
                />
              </div>
            </div>
          </div>
        </div>
      </main>

      <style>{`
        .custom-scrollbar::-webkit-scrollbar { width: 4px; }
        .custom-scrollbar::-webkit-scrollbar-track { background: transparent; }
        .custom-scrollbar::-webkit-scrollbar-thumb { background: #334155; border-radius: 10px; }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover { background: #475569; }
        
        @keyframes scan-line {
          0% { top: 0%; }
          100% { top: 100%; }
        }
        .animate-scan-line { animation: scan-line 6s linear infinite; }

        @keyframes bounce-custom {
          0%, 100% { transform: scaleY(1); opacity: 0.6; }
          50% { transform: scaleY(2.2); opacity: 1; }
        }
        .animate-bounce-custom { 
          animation: bounce-custom 0.8s ease-in-out infinite;
          transform-origin: bottom;
        }

        @keyframes scale-in-center {
          0% { transform: translate(-50%, 0) scale(0); opacity: 0; }
          100% { transform: translate(-50%, 0) scale(1); opacity: 1; }
        }
        .scale-in-center { animation: scale-in-center 0.4s cubic-bezier(0.250, 0.460, 0.450, 0.940) both; }
      `}</style>
    </div>
  );
}
