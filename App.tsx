
import React, { useState, useRef, useEffect, useCallback } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality, Type, FunctionDeclaration } from '@google/genai';
import { HealthStats } from './types';
import Dashboard from './components/Dashboard';
import { decode, decodeAudioData, encode, float32ToInt16 } from './utils/audioHelpers';

// 10 FPS provides ultra-smooth motion delta analysis
const FRAME_RATE = 10; 
const JPEG_QUALITY = 0.3; 
const MAX_RETRIES = 5;

const App: React.FC = () => {
  const [isActive, setIsActive] = useState(false);
  const [isCalibrating, setIsCalibrating] = useState(false);
  const [isReconnecting, setIsReconnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  const [stats, setStats] = useState<HealthStats>({
    postureScore: 100,
    blinkRate: 15,
    fatigueLevel: 'Low',
    proximityScore: 100,
    postureStatus: 'Good',
    recommendation: 'Initialize Optivize for hyper-sensitive live monitoring.',
    baselineSet: false
  });

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sessionRef = useRef<any>(null);
  const nextStartTimeRef = useRef(0);
  const audioContextRef = useRef<AudioContext | null>(null);
  const outputAudioContextRef = useRef<AudioContext | null>(null);
  const intervalRef = useRef<number | null>(null);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const retryCountRef = useRef(0);
  const streamRef = useRef<MediaStream | null>(null);

  const updateStats = useCallback((newStats: Partial<HealthStats>) => {
    setStats(prev => ({ ...prev, ...newStats }));
  }, []);

  const stopMonitoring = useCallback((keepStream = false) => {
    setIsActive(false);
    setIsCalibrating(false);
    setIsReconnecting(false);
    if (intervalRef.current) window.clearInterval(intervalRef.current);
    if (sessionRef.current) sessionRef.current = null;
    
    if (!keepStream && streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
      if (videoRef.current) videoRef.current.srcObject = null;
    }
    
    sourcesRef.current.forEach(source => {
      try { source.stop(); } catch(e) {}
    });
    sourcesRef.current.clear();
  }, []);

  const healthUpdateFunction: FunctionDeclaration = {
    name: 'updateHealthStats',
    parameters: {
      type: Type.OBJECT,
      description: 'Updates health metrics. Trigger INSTANTLY on any skeletal or ocular movement.',
      properties: {
        postureScore: { type: Type.NUMBER, description: 'Alignment score (0-100).' },
        proximityScore: { type: Type.NUMBER, description: 'Distance score (0-100).' },
        blinkRate: { type: Type.NUMBER, description: 'Rolling 30s BPM.' },
        fatigueLevel: { type: Type.STRING, enum: ['Low', 'Medium', 'High'] },
        postureStatus: { type: Type.STRING, enum: ['Good', 'Fair', 'Poor'] },
        recommendation: { type: Type.STRING, description: 'Punchy feedback.' },
        baselineSet: { type: Type.BOOLEAN }
      },
      required: ['postureScore', 'proximityScore', 'blinkRate', 'fatigueLevel', 'postureStatus', 'recommendation'],
    },
  };

  const connectToLiveAPI = async (stream: MediaStream) => {
    const ai = new GoogleGenAI({ apiKey: process.env.API_KEY || '' });
    
    if (!audioContextRef.current) {
      audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
    }
    if (!outputAudioContextRef.current) {
      outputAudioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
    }

    const sessionPromise = ai.live.connect({
      model: 'gemini-2.5-flash-native-audio-preview-12-2025',
      config: {
        responseModalities: [Modality.AUDIO],
        systemInstruction: `You are Optivize HYPER-REACTIVE. 
          
          CORE MISSION: ZERO-LATENCY POSTURE ANALYSIS.
          You are analyzing video at 10 frames per second. 
          
          HYPER-SENSITIVITY PROTOCOL:
          - Be EXTREMELY picky. If the user tilts their neck more than 5 degrees, instantly move postureStatus to 'Fair'.
          - If they slouch or lean forward even slightly, trigger 'updateHealthStats' IMMEDIATELY.
          - Do not smooth the data. Every frame delta matters.
          - Use a rolling 30-second window for blink rate (count * 2).
          
          React as fast as a human reflex. Speed of the tool call is the only metric that matters.`,
        tools: [{ functionDeclarations: [healthUpdateFunction] }],
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } },
        },
      },
      callbacks: {
        onopen: () => {
          retryCountRef.current = 0;
          setIsReconnecting(false);
          setError(null);
          
          const source = audioContextRef.current!.createMediaStreamSource(stream);
          const scriptProcessor = audioContextRef.current!.createScriptProcessor(4096, 1, 1);
          scriptProcessor.onaudioprocess = (e) => {
            const inputData = e.inputBuffer.getChannelData(0);
            const int16 = float32ToInt16(inputData);
            const pcmBlob = {
              data: encode(new Uint8Array(int16.buffer)),
              mimeType: 'audio/pcm;rate=16000',
            };
            sessionPromise.then(session => session.sendRealtimeInput({ media: pcmBlob }));
          };
          source.connect(scriptProcessor);
          scriptProcessor.connect(audioContextRef.current!.destination);

          intervalRef.current = window.setInterval(() => {
            if (videoRef.current && canvasRef.current) {
              const ctx = canvasRef.current.getContext('2d');
              canvasRef.current.width = videoRef.current.videoWidth;
              canvasRef.current.height = videoRef.current.videoHeight;
              ctx?.drawImage(videoRef.current, 0, 0);
              canvasRef.current.toBlob(async (blob) => {
                if (blob) {
                  const reader = new FileReader();
                  reader.onloadend = () => {
                    const base64Data = (reader.result as string).split(',')[1];
                    sessionPromise.then(session => session.sendRealtimeInput({
                      media: { data: base64Data, mimeType: 'image/jpeg' }
                    }));
                  };
                  reader.readAsDataURL(blob);
                }
              }, 'image/jpeg', JPEG_QUALITY);
            }
          }, 1000 / FRAME_RATE);
        },
        onmessage: async (msg: LiveServerMessage) => {
          if (msg.toolCall) {
            for (const fc of msg.toolCall.functionCalls) {
              if (fc.name === 'updateHealthStats') {
                updateStats(fc.args as any);
                sessionPromise.then(session => session.sendToolResponse({
                  functionResponses: { id: fc.id, name: fc.name, response: { result: "ok" } }
                }));
              }
            }
          }
          const audioData = msg.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
          if (audioData && outputAudioContextRef.current) {
            nextStartTimeRef.current = Math.max(nextStartTimeRef.current, outputAudioContextRef.current.currentTime);
            const buffer = await decodeAudioData(decode(audioData), outputAudioContextRef.current, 24000, 1);
            const source = outputAudioContextRef.current.createBufferSource();
            source.buffer = buffer;
            source.connect(outputAudioContextRef.current.destination);
            source.onended = () => sourcesRef.current.delete(source);
            source.start(nextStartTimeRef.current);
            nextStartTimeRef.current += buffer.duration;
            sourcesRef.current.add(source);
          }
          if (msg.serverContent?.interrupted) {
            sourcesRef.current.forEach(s => { try { s.stop(); } catch(e) {} });
            sourcesRef.current.clear();
            nextStartTimeRef.current = 0;
          }
        },
        onerror: (e: any) => {
          console.error('Optivize Session Error:', e);
          handleRetry();
        },
        onclose: () => {
          if (isActive && !isReconnecting) {
             handleRetry();
          }
        }
      }
    });
    sessionRef.current = sessionPromise;
  };

  const handleRetry = useCallback(() => {
    if (retryCountRef.current < MAX_RETRIES) {
      setIsReconnecting(true);
      const delay = Math.pow(1.5, retryCountRef.current) * 800; // Faster retry curve
      retryCountRef.current++;
      
      setTimeout(() => {
        if (streamRef.current) {
          stopMonitoring(true);
          setIsActive(true);
          connectToLiveAPI(streamRef.current);
        }
      }, delay);
    } else {
      setError("High-speed analysis service is busy. Please restart in a few moments.");
      stopMonitoring();
    }
  }, [isActive, stopMonitoring]);

  const startMonitoring = async () => {
    try {
      setError(null);
      retryCountRef.current = 0;
      const stream = await navigator.mediaDevices.getUserMedia({ 
        audio: true, 
        video: { width: 1280, height: 720, facingMode: "user" } 
      });

      streamRef.current = stream;
      if (videoRef.current) videoRef.current.srcObject = stream;
      
      setIsActive(true);
      await connectToLiveAPI(stream);
      setTimeout(() => {
        if (!isReconnecting) setIsCalibrating(true);
        setTimeout(() => {
          setIsCalibrating(false);
          updateStats({ baselineSet: true, postureScore: 100, proximityScore: 100, postureStatus: 'Good' });
        }, 2000); // Shorter calibration for instant-on feel
      }, 500);

    } catch (err: any) {
      setError("Connection to Vision Core failed. Check camera permissions.");
      stopMonitoring();
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 font-sans selection:bg-indigo-500/30">
      <Dashboard 
        stats={stats} 
        isActive={isActive} 
        isCalibrating={isCalibrating}
        isReconnecting={isReconnecting}
        error={error}
        onToggle={() => isActive ? stopMonitoring() : startMonitoring()}
        onCalibrate={() => setIsCalibrating(true)}
        videoRef={videoRef}
        canvasRef={canvasRef}
      />
      
      <footer className="mt-auto py-12 px-6 border-t border-slate-900 bg-slate-950">
        <div className="max-w-6xl mx-auto grid grid-cols-1 md:grid-cols-3 gap-12 text-sm text-slate-500">
          <div className="space-y-4">
            <h4 className="text-white font-black uppercase tracking-widest text-[10px]">Hyper-Sensitive Vision</h4>
            <p className="leading-relaxed opacity-60">Optivize analyzes 10 frames per second with zero-tolerance for neck misalignment or digital slouching.</p>
          </div>
          <div className="space-y-4">
            <h4 className="text-white font-black uppercase tracking-widest text-[10px]">Instant Biofeedback</h4>
            <p className="leading-relaxed opacity-60">Protocol results are rendered in real-time to create an immediate corrective reflex loop for the user.</p>
          </div>
          <div className="space-y-4">
            <h4 className="text-white font-black uppercase tracking-widest text-[10px]">Disclaimer</h4>
            <p className="leading-relaxed italic opacity-60">This AI-driven ergonomic tool provides real-time coaching but is not a medical device.</p>
          </div>
        </div>
      </footer>
    </div>
  );
};

export default App;
