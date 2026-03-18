/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { 
  Activity, 
  Play, 
  Square, 
  Plus, 
  Trash2, 
  Settings2, 
  Waves, 
  Eye, 
  Link as LinkIcon,
  Zap,
  Layers,
  Maximize2,
  ChevronRight,
  ChevronDown
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import * as d3 from 'd3-shape';
import { interpolate } from 'd3-interpolate';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

// --- Utility ---
function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// --- Types ---

type Point = { x: number; y: number; id: string };

type CurveType = 'macro' | 'micro';

interface MorphologyCurve {
  id: string;
  name: string;
  type: CurveType;
  points: Point[];
  interpolation: 'linear' | 'basis' | 'monotone';
  modulatorId?: string; // For nesting
  modulatorStrength: number;
  modulatorFrequency: number;
  color: string;
}

interface VisualContent {
  id: string;
  name: string;
  type: 'geometry' | 'particles';
  shape: 'circle' | 'square' | 'triangle' | 'pentagon' | 'star' | 'hexagon';
  visible: boolean;
  color: string;
}

interface Mapping {
  id: string;
  curveId: string;
  target: string; // e.g. "audio.freq", "visual.obj-1.scale"
  range: [number, number];
  inverted: boolean;
}

interface EngineState {
  isPlaying: boolean;
  time: number; // 0 to 1 normalized loop time
  duration: number; // in seconds
}

// --- Constants ---

const TRAJECTORY_COLORS = [
  '#10b981', // Emerald
  '#3b82f6', // Blue
  '#f59e0b', // Amber
  '#ef4444', // Red
  '#8b5cf6', // Violet
  '#ec4899', // Pink
  '#06b6d4', // Cyan
];

const INITIAL_MACRO_CURVE: MorphologyCurve = {
  id: 'macro-1',
  name: 'Trajectory 1',
  type: 'macro',
  points: [
    { x: 0, y: 0.2, id: 'p1' },
    { x: 0.3, y: 0.8, id: 'p2' },
    { x: 0.7, y: 0.5, id: 'p3' },
    { x: 1, y: 0.1, id: 'p4' },
  ],
  interpolation: 'monotone',
  modulatorStrength: 0.1,
  modulatorFrequency: 10,
  color: TRAJECTORY_COLORS[0],
};

const INITIAL_MICRO_CURVE: MorphologyCurve = {
  id: 'micro-1',
  name: 'Trajectory 2',
  type: 'micro',
  points: [
    { x: 0, y: 0.5, id: 'm1' },
    { x: 0.5, y: 1.0, id: 'm2' },
    { x: 1, y: 0.5, id: 'm3' },
  ],
  interpolation: 'basis',
  modulatorStrength: 0,
  modulatorFrequency: 1,
  color: TRAJECTORY_COLORS[1],
};

const BASE_MAPPING_TARGETS = [
  { id: 'none', label: 'None', group: 'General' },
  { id: 'audio.freq', label: 'Audio: Frequency (Pitch)', group: 'Audio' },
  { id: 'audio.cutoff', label: 'Audio: Filter Cutoff', group: 'Audio' },
  { id: 'audio.resonance', label: 'Audio: Filter Resonance', group: 'Audio' },
  { id: 'audio.noise', label: 'Audio: Noise Ratio', group: 'Audio' },
  { id: 'audio.gain', label: 'Audio: Amplitude', group: 'Audio' },
];

// --- Interpolation Helpers ---

const interpolateLinear = (points: Point[], x: number) => {
  if (points.length === 0) return 0;
  if (x <= points[0].x) return points[0].y;
  if (x >= points[points.length - 1].x) return points[points.length - 1].y;
  
  for (let i = 0; i < points.length - 1; i++) {
    const p1 = points[i];
    const p2 = points[i + 1];
    if (x >= p1.x && x <= p2.x) {
      const ratio = (x - p1.x) / (p2.x - p1.x);
      return p1.y + (p2.y - p1.y) * ratio;
    }
  }
  return 0;
};

const interpolateMonotone = (points: Point[], x: number) => {
  const n = points.length;
  if (n < 2) return points[0]?.y || 0;
  if (x <= points[0].x) return points[0].y;
  if (x >= points[n - 1].x) return points[n - 1].y;

  const dx = new Array(n - 1);
  const ms = new Array(n - 1);
  for (let i = 0; i < n - 1; i++) {
    dx[i] = points[i + 1].x - points[i].x;
    ms[i] = (points[i + 1].y - points[i].y) / dx[i];
  }

  const c = new Array(n);
  c[0] = ms[0];
  for (let i = 1; i < n - 1; i++) {
    if (ms[i - 1] * ms[i] <= 0) {
      c[i] = 0;
    } else {
      const common = dx[i - 1] + dx[i];
      c[i] = (3 * common) / ((common + dx[i]) / ms[i - 1] + (common + dx[i - 1]) / ms[i]);
    }
  }
  c[n - 1] = ms[n - 2];

  let i = 0;
  while (i < n - 2 && x > points[i + 1].x) i++;

  const h = dx[i];
  const t = (x - points[i].x) / h;
  const t2 = t * t;
  const t3 = t2 * t;

  return (2 * t3 - 3 * t2 + 1) * points[i].y +
         (t3 - 2 * t2 + t) * h * c[i] +
         (-2 * t3 + 3 * t2) * points[i + 1].y +
         (t3 - t2) * h * c[i + 1];
};

// Simple B-Spline approximation for 'basis'
const interpolateBasis = (points: Point[], x: number) => {
  // For basis, we'll use monotone as a high-quality smooth approximation
  // that strictly respects point values (unlike raw B-splines which can overshoot/undershoot)
  return interpolateMonotone(points, x);
};

// --- Core Logic ---

export default function App() {
  const [curves, setCurves] = useState<MorphologyCurve[]>([INITIAL_MACRO_CURVE, INITIAL_MICRO_CURVE]);
  const [visualContents, setVisualContents] = useState<VisualContent[]>([
    { id: 'vis-1', name: 'Geometry 1', type: 'geometry', shape: 'circle', visible: true, color: '#10b981' },
    { id: 'vis-2', name: 'Particles 1', type: 'particles', shape: 'circle', visible: true, color: '#3b82f6' },
  ]);
  const [mappings, setMappings] = useState<Mapping[]>([
    { id: 'map-1', curveId: 'macro-1', target: 'audio.freq', range: [100, 800], inverted: false },
    { id: 'map-2', curveId: 'macro-1', target: 'visual.vis-1.scale', range: [0, 1], inverted: false },
    { id: 'map-3', curveId: 'micro-1', target: 'audio.noise', range: [0, 0.5], inverted: false },
    { id: 'map-4', curveId: 'macro-1', target: 'audio.gain', range: [0, 0.8], inverted: false },
  ]);
  const [engine, setEngine] = useState<EngineState & { zoom: number }>({ isPlaying: false, time: 0, duration: 4.0, zoom: 1 });
  const [activeCurveId, setActiveCurveId] = useState<string>('macro-1');
  const [showVisualSettings, setShowVisualSettings] = useState(false);
  
  // Use a ref for curves to ensure the high-frequency loop always has the latest data
  const curvesRef = useRef<MorphologyCurve[]>(curves);
  const visualContentsRef = useRef<VisualContent[]>(visualContents);
  const visualStateRef = useRef<Record<string, { rotation: number; complexity: number; x: number; y: number }>>({});

  useEffect(() => {
    curvesRef.current = curves;
  }, [curves]);

  useEffect(() => {
    visualContentsRef.current = visualContents;
    // Initialize state for new contents
    visualContents.forEach(vc => {
      if (!visualStateRef.current[vc.id]) {
        visualStateRef.current[vc.id] = { rotation: 0, complexity: 0, x: 0.5, y: 0.5 };
      }
    });
  }, [visualContents]);

  useEffect(() => {
    // Migrate old complexitySpeed mappings to complexity
    setMappings(prev => prev.map(m => {
      if (m.target.endsWith('.complexitySpeed')) {
        return { ...m, target: m.target.replace('.complexitySpeed', '.complexity') };
      }
      return m;
    }));
  }, []);

  const mappingTargets = useMemo(() => {
    const targets = [...BASE_MAPPING_TARGETS];
    visualContents.forEach(vc => {
      targets.push(
        { id: `visual.${vc.id}.scale`, label: `${vc.name}: Scale`, group: vc.name },
        { id: `visual.${vc.id}.rotation`, label: `${vc.name}: Rotation Speed`, group: vc.name },
        { id: `visual.${vc.id}.complexity`, label: `${vc.name}: Complexity`, group: vc.name },
        { id: `visual.${vc.id}.hue`, label: `${vc.name}: Color Hue`, group: vc.name },
        { id: `visual.${vc.id}.x`, label: `${vc.name}: Horizontal Pos`, group: vc.name },
        { id: `visual.${vc.id}.y`, label: `${vc.name}: Vertical Pos`, group: vc.name },
      );
    });
    return targets;
  }, [visualContents]);

  const audioCtxRef = useRef<AudioContext | null>(null);
  const audioNodesRef = useRef<{
    osc: OscillatorNode;
    filter: BiquadFilterNode;
    noise: AudioWorkletNode | AudioBufferSourceNode;
    noiseGain: GainNode;
    masterGain: GainNode;
  } | null>(null);
  
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const requestRef = useRef<number>(null);
  const startTimeRef = useRef<number>(0);

  // --- Audio Engine ---
  const initAudio = useCallback(() => {
    if (audioCtxRef.current) return;
    const ctx = new AudioContext();
    audioCtxRef.current = ctx;

    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 1000;
    filter.Q.value = 1;

    const masterGain = ctx.createGain();
    masterGain.gain.value = 0;

    // Simple noise generator
    const bufferSize = 2 * ctx.sampleRate;
    const noiseBuffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const output = noiseBuffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      output[i] = Math.random() * 2 - 1;
    }
    const noise = ctx.createBufferSource();
    noise.buffer = noiseBuffer;
    noise.loop = true;
    
    const noiseGain = ctx.createGain();
    noiseGain.gain.value = 0;

    osc.connect(filter);
    filter.connect(masterGain);
    noise.connect(noiseGain);
    noiseGain.connect(masterGain);
    masterGain.connect(ctx.destination);

    osc.start();
    noise.start();

    audioNodesRef.current = { osc, filter, noise, noiseGain, masterGain };
  }, []);

  // --- Curve Math ---
  const calculateCurveValue = (curveId: string, t: number, curvesList: MorphologyCurve[], depth = 0): number => {
    if (depth > 5) return 0; // Prevent infinite recursion
    const curve = curvesList.find(c => c.id === curveId);
    if (!curve) return 0;

    const sortedPoints = [...curve.points].sort((a, b) => a.x - b.x);
    
    let baseVal = 0;
    if (curve.interpolation === 'monotone') {
      baseVal = interpolateMonotone(sortedPoints, t);
    } else if (curve.interpolation === 'basis') {
      baseVal = interpolateBasis(sortedPoints, t);
    } else {
      baseVal = interpolateLinear(sortedPoints, t);
    }

    // Apply nesting if exists
    if (curve.modulatorId) {
      const modVal = calculateCurveValue(curve.modulatorId, (t * curve.modulatorFrequency) % 1, curvesList, depth + 1);
      baseVal += (modVal - 0.5) * curve.modulatorStrength;
    }

    return Math.max(0, Math.min(1, baseVal));
  };

  const getCurveValue = useCallback((curveId: string, t: number): number => {
    return calculateCurveValue(curveId, t, curves);
  }, [curves]);

  // --- Loop ---
  const update = useCallback((timestamp: number) => {
    if (!engine.isPlaying) return;

    if (!startTimeRef.current) startTimeRef.current = timestamp;
    const elapsed = (timestamp - startTimeRef.current) / 1000;
    const normalizedTime = (elapsed % engine.duration) / engine.duration;
    
    setEngine(prev => ({ ...prev, time: normalizedTime }));

    // Update Engines
    const values: Record<string, number> = {
      'audio.gain': 0, // Default to silence if not mapped
      'audio.freq': 440,
      'audio.cutoff': 2000,
      'audio.resonance': 1,
      'audio.noise': 0
    };

    mappings.forEach(m => {
      const v = calculateCurveValue(m.curveId, normalizedTime, curvesRef.current);
      const scaled = m.inverted ? m.range[1] - v * (m.range[1] - m.range[0]) : m.range[0] + v * (m.range[1] - m.range[0]);
      values[m.target] = scaled;
    });

    // Audio Update
    if (audioNodesRef.current && audioCtxRef.current) {
      const { osc, filter, noiseGain, masterGain } = audioNodesRef.current;
      const now = audioCtxRef.current.currentTime;
      
      if (values['audio.freq']) osc.frequency.setTargetAtTime(values['audio.freq'], now, 0.05);
      if (values['audio.cutoff']) filter.frequency.setTargetAtTime(values['audio.cutoff'], now, 0.05);
      if (values['audio.resonance']) filter.Q.setTargetAtTime(values['audio.resonance'], now, 0.05);
      if (values['audio.noise']) noiseGain.gain.setTargetAtTime(values['audio.noise'], now, 0.05);
      if (values['audio.gain']) masterGain.gain.setTargetAtTime(values['audio.gain'], now, 0.05);
    }

    // Visual Update
    const canvas = canvasRef.current;
    if (canvas) {
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.fillStyle = '#0a0a0a';
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        const centerX = canvas.width / 2;
        const centerY = canvas.height / 2;
        const zoom = engine.zoom;

        ctx.save();
        // Apply global camera zoom
        ctx.translate(centerX, centerY);
        ctx.scale(zoom, zoom);
        ctx.translate(-centerX, -centerY);

        visualContentsRef.current.forEach(vc => {
          if (!vc.visible) return;

          const state = visualStateRef.current[vc.id];
          if (!state) return;

          const objValues: Record<string, number> = {
            scale: 1,
            rotationSpeed: 0,
            complexity: 0,
            hue: 200,
            x: 0.5,
            y: 0.5,
          };

          mappings.forEach(m => {
            if (m.target.startsWith(`visual.${vc.id}.`)) {
              const subTarget = m.target.split('.').pop();
              const v = calculateCurveValue(m.curveId, normalizedTime, curvesRef.current);
              const scaled = m.inverted ? m.range[1] - v * (m.range[1] - m.range[0]) : m.range[0] + v * (m.range[1] - m.range[0]);
              
              if (subTarget === 'scale') objValues.scale = scaled;
              if (subTarget === 'rotation') objValues.rotationSpeed = scaled;
              if (subTarget === 'complexity') objValues.complexity = scaled;
              if (subTarget === 'hue') objValues.hue = scaled;
              if (subTarget === 'x') objValues.x = scaled;
              if (subTarget === 'y') objValues.y = scaled;
            }
          });

          // Update continuous states
          const deltaTime = 1 / 60; // Approximate
          state.rotation += objValues.rotationSpeed * deltaTime;
          state.complexity = objValues.complexity;
          state.x = objValues.x;
          state.y = objValues.y;

          ctx.save();
          ctx.translate(state.x * canvas.width, state.y * canvas.height);
          ctx.rotate(state.rotation * Math.PI * 2);
          ctx.scale(objValues.scale, objValues.scale);

          ctx.strokeStyle = `hsla(${objValues.hue}, 85%, 70%, 1.0)`;
          ctx.lineWidth = 3 / (objValues.scale * zoom);

          if (vc.type === 'geometry') {
            let sides = 3;
            let isStar = false;
            switch (vc.shape) {
              case 'circle': sides = 64; break;
              case 'square': sides = 4; break;
              case 'triangle': sides = 3; break;
              case 'pentagon': sides = 5; break;
              case 'hexagon': sides = 6; break;
              case 'star': sides = 10; isStar = true; break;
            }

            ctx.beginPath();
            for (let i = 0; i < sides; i++) {
              const angle = (i / sides) * Math.PI * 2 - Math.PI / 2;
              let r = 50 + Math.sin(normalizedTime * Math.PI * 8 + i * 2) * (10 + state.complexity * 20);
              
              if (isStar && i % 2 === 1) {
                r *= 0.4;
              }

              const x = Math.cos(angle) * r;
              const y = Math.sin(angle) * r;
              if (i === 0) ctx.moveTo(x, y);
              else ctx.lineTo(x, y);
            }
            ctx.closePath();
            ctx.stroke();
          } else if (vc.type === 'particles') {
            const particleCount = Math.floor(state.complexity * 60 + 10);
            for (let i = 0; i < particleCount; i++) {
              const pAngle = (i / particleCount) * Math.PI * 2 + normalizedTime * 4;
              const pR = (70 + Math.cos(normalizedTime * 8 + i) * 30) * (1 + state.complexity * 0.5);
              ctx.fillStyle = `hsla(${objValues.hue + i * 3}, 80%, 65%, 0.7)`;
              ctx.beginPath();
              ctx.arc(Math.cos(pAngle) * pR, Math.sin(pAngle) * pR, (2 + state.complexity * 3) / (objValues.scale * zoom), 0, Math.PI * 2);
              ctx.fill();
            }
          }

          ctx.restore();
        });
        ctx.restore();
      }
    }

    requestRef.current = requestAnimationFrame(update);
  }, [engine.isPlaying, engine.duration, engine.zoom, mappings, getCurveValue]);

  useEffect(() => {
    if (engine.isPlaying) {
      requestRef.current = requestAnimationFrame(update);
    } else {
      if (requestRef.current) cancelAnimationFrame(requestRef.current);
      startTimeRef.current = 0;
      if (audioNodesRef.current) {
        audioNodesRef.current.masterGain.gain.setTargetAtTime(0, audioCtxRef.current!.currentTime, 0.1);
      }
    }
    return () => {
      if (requestRef.current) cancelAnimationFrame(requestRef.current);
    };
  }, [engine.isPlaying, update]);

  const togglePlay = () => {
    if (!engine.isPlaying) initAudio();
    setEngine(prev => ({ ...prev, isPlaying: !prev.isPlaying }));
  };

  // --- UI Handlers ---
  const addPoint = (curveId: string, x: number, y: number) => {
    setCurves(prev => prev.map(c => {
      if (c.id === curveId) {
        return { ...c, points: [...c.points, { x, y, id: Math.random().toString(36).substr(2, 9) }] };
      }
      return c;
    }));
  };

  const movePoint = (curveId: string, pointId: string, x: number, y: number) => {
    setCurves(prev => prev.map(c => {
      if (c.id === curveId) {
        return {
          ...c,
          points: c.points.map(p => p.id === pointId ? { ...p, x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y)) } : p)
        };
      }
      return c;
    }));
  };

  const removePoint = (curveId: string, pointId: string) => {
    setCurves(prev => prev.map(c => {
      if (c.id === curveId && c.points.length > 2) {
        return { ...c, points: c.points.filter(p => p.id !== pointId) };
      }
      return c;
    }));
  };

  const addMapping = () => {
    const newMap: Mapping = {
      id: `map-${Date.now()}`,
      curveId: activeCurveId,
      target: 'none',
      range: [0, 1],
      inverted: false
    };
    setMappings([...mappings, newMap]);
  };

  const updateMapping = (id: string, updates: Partial<Mapping>) => {
    setMappings(prev => prev.map(m => {
      if (m.id === id) {
        const newMap = { ...m, ...updates };
        // Default ranges for visual parameters when target changes
        if (updates.target) {
          if (updates.target.endsWith('.scale')) newMap.range = [0, 1];
          else if (updates.target.endsWith('.rotation')) newMap.range = [0, 5];
          else if (updates.target.endsWith('.complexity')) newMap.range = [0, 1];
          else if (updates.target.endsWith('.hue')) newMap.range = [0, 360];
          else if (updates.target.endsWith('.x') || updates.target.endsWith('.y')) newMap.range = [0, 1];
        }
        return newMap;
      }
      return m;
    }));
  };

  const removeMapping = (id: string) => {
    setMappings(prev => prev.filter(m => m.id !== id));
  };

  const addCurve = () => {
    const id = `curve-${Date.now()}`;
    const newCurve: MorphologyCurve = { 
      ...INITIAL_MACRO_CURVE, 
      id, 
      name: `Trajectory ${curves.length + 1}`,
      color: TRAJECTORY_COLORS[curves.length % TRAJECTORY_COLORS.length]
    };
    setCurves(prev => {
      const next = [...prev, newCurve];
      return next.map((c, i) => ({ ...c, name: c.name.startsWith('Trajectory ') ? `Trajectory ${i + 1}` : c.name }));
    });
    setActiveCurveId(id);
  };

  const removeCurve = (id: string) => {
    if (curves.length <= 1) return;
    
    setCurves(prev => {
      const filtered = prev.filter(c => c.id !== id);
      const renumbered = filtered.map((c, i) => ({ ...c, name: c.name.startsWith('Trajectory ') ? `Trajectory ${i + 1}` : c.name }));
      // Clean up references to this curve as a modulator
      return renumbered.map(c => c.modulatorId === id ? { ...c, modulatorId: undefined } : c);
    });

    setMappings(prev => prev.filter(m => m.curveId !== id));

    if (activeCurveId === id) {
      const remaining = curves.filter(c => c.id !== id);
      if (remaining.length > 0) setActiveCurveId(remaining[0].id);
    }
  };

  const activeCurve = useMemo(() => curves.find(c => c.id === activeCurveId) || curves[0], [curves, activeCurveId]);

  return (
    <div className="flex flex-col h-screen bg-[#0a0a0a] text-[#e0e0e0] font-sans selection:bg-emerald-500/30">
      {/* Header */}
      <header className="h-16 border-b border-white/5 flex items-center justify-between px-6 bg-[#111111]">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 bg-emerald-500 rounded-lg flex items-center justify-center">
            <Activity className="text-black w-5 h-5" />
          </div>
          <div>
            <h1 className="text-lg font-semibold tracking-tight">MorphoSynch</h1>
            <p className="text-[10px] text-white/40 uppercase tracking-widest font-mono">Spectromorphological Synthesizer</p>
          </div>
        </div>

        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2 bg-black/40 px-3 py-1.5 rounded-full border border-white/5">
            <span className="text-[10px] font-mono text-white/40">TIME</span>
            <div className="w-32 h-1 bg-white/10 rounded-full overflow-hidden">
              <div 
                className="h-full bg-emerald-500 transition-all duration-100 ease-linear" 
                style={{ width: `${engine.time * 100}%` }}
              />
            </div>
          </div>
          
          <button 
            onClick={togglePlay}
            className={cn(
              "flex items-center gap-2 px-6 py-2 rounded-full font-medium transition-all active:scale-95",
              engine.isPlaying 
                ? "bg-red-500/10 text-red-500 border border-red-500/20" 
                : "bg-emerald-500 text-black hover:bg-emerald-400"
            )}
          >
            {engine.isPlaying ? <Square className="w-4 h-4 fill-current" /> : <Play className="w-4 h-4 fill-current" />}
            {engine.isPlaying ? "STOP" : "PLAY"}
          </button>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 flex overflow-hidden">
        {/* Left Sidebar: Curves & Mappings */}
        <aside className="w-80 border-r border-white/5 flex flex-col bg-[#0f0f0f]">
          <div className="p-4 border-b border-white/5">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-xs font-bold uppercase tracking-widest text-white/40 flex items-center gap-2">
                <Layers className="w-3 h-3" /> Trajectories
              </h2>
              <button 
                onClick={addCurve}
                className="p-1 hover:bg-white/5 rounded text-white/40 hover:text-white"
              >
                <Plus className="w-4 h-4" />
              </button>
            </div>
            <div className="space-y-1">
              {curves.map(c => (
                <div key={c.id} className="group relative">
                  <div className={cn(
                    "w-full px-3 py-2 rounded-lg text-sm transition-all flex items-center justify-between",
                    activeCurveId === c.id ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20" : "hover:bg-white/5 text-white/60"
                  )}>
                    <input 
                      value={c.name}
                      onChange={(e) => setCurves(prev => prev.map(curr => curr.id === c.id ? { ...curr, name: e.target.value } : curr))}
                      onClick={() => setActiveCurveId(c.id)}
                      className="bg-transparent outline-none truncate w-full cursor-pointer"
                    />
                    <div className="flex items-center gap-2">
                      <div className="w-2 h-2 rounded-full" style={{ backgroundColor: c.color }} />
                      {curves.length > 1 && (
                        <button 
                          onClick={(e) => { e.stopPropagation(); removeCurve(c.id); }}
                          className="p-1 text-white/0 group-hover:text-white/20 hover:text-red-500 transition-all"
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="flex-1 overflow-y-auto p-4 custom-scrollbar">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-xs font-bold uppercase tracking-widest text-white/40 flex items-center gap-2">
                <LinkIcon className="w-3 h-3" /> Parameter Mapping
              </h2>
              <button 
                onClick={addMapping}
                className="p-1 hover:bg-white/5 rounded text-white/40 hover:text-white"
              >
                <Plus className="w-4 h-4" />
              </button>
            </div>
            
            <div className="space-y-4">
              {mappings.map(m => (
                <div key={m.id} className="p-3 rounded-xl bg-black/40 border border-white/5 space-y-3">
                  <div className="flex items-center justify-between">
                    <select 
                      value={m.curveId}
                      onChange={(e) => updateMapping(m.id, { curveId: e.target.value })}
                      className="bg-transparent text-[10px] font-mono text-emerald-500 outline-none uppercase"
                    >
                      {curves.map(c => <option key={c.id} value={c.id} className="bg-[#111]">{c.name}</option>)}
                    </select>
                    <button onClick={() => removeMapping(m.id)} className="text-white/20 hover:text-red-500 transition-colors">
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </div>
                  
                  <select 
                    value={m.target}
                    onChange={(e) => updateMapping(m.id, { target: e.target.value })}
                    className="w-full bg-[#1a1a1a] border border-white/10 rounded px-2 py-1 text-xs outline-none"
                  >
                    {mappingTargets.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
                  </select>

                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="text-[9px] text-white/30 uppercase block mb-1">Min</label>
                      <input 
                        type="number" 
                        value={m.range[0]} 
                        onChange={(e) => updateMapping(m.id, { range: [parseFloat(e.target.value), m.range[1]] })}
                        className="w-full bg-[#1a1a1a] border border-white/10 rounded px-2 py-1 text-xs outline-none font-mono"
                      />
                    </div>
                    <div>
                      <label className="text-[9px] text-white/30 uppercase block mb-1">Max</label>
                      <input 
                        type="number" 
                        value={m.range[1]} 
                        onChange={(e) => updateMapping(m.id, { range: [m.range[0], parseFloat(e.target.value)] })}
                        className="w-full bg-[#1a1a1a] border border-white/10 rounded px-2 py-1 text-xs outline-none font-mono"
                      />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </aside>

        {/* Center: Curve Editor & Preview */}
        <section className="flex-1 flex flex-col relative bg-black">
          {/* Visual Preview */}
          <div className="flex-1 relative overflow-hidden">
            <canvas 
              ref={canvasRef} 
              width={800} 
              height={600} 
              className="w-full h-full object-cover opacity-100"
            />
            
            {/* Overlay Controls */}
            <div className="absolute top-6 left-6 flex flex-col gap-2">
              <div className="bg-black/60 backdrop-blur-md border border-white/10 p-4 rounded-2xl flex items-center gap-4">
                <div className="w-10 h-10 rounded-full bg-emerald-500/20 flex items-center justify-center border border-emerald-500/30">
                  <Zap className="w-5 h-5 text-emerald-500" />
                </div>
                <div>
                  <h3 className="text-sm font-semibold">Active Morphology</h3>
                  <p className="text-xs text-white/40">{activeCurve.name}</p>
                </div>
              </div>
            </div>

            <div className="absolute bottom-6 right-6">
               <div className="bg-black/60 backdrop-blur-md border border-white/10 p-2 rounded-xl flex items-center gap-2">
                  <button 
                    onClick={() => setEngine(prev => ({ ...prev, zoom: prev.zoom === 1 ? 2 : prev.zoom === 2 ? 0.5 : 1 }))}
                    className={cn("p-2 hover:bg-white/5 rounded-lg transition-all", engine.zoom !== 1 ? "text-emerald-500" : "text-white/40")}
                  >
                    <Maximize2 className="w-4 h-4" />
                  </button>
                  <button 
                    onClick={() => setShowVisualSettings(!showVisualSettings)}
                    className={cn("p-2 hover:bg-white/5 rounded-lg transition-all", showVisualSettings ? "text-emerald-500" : "text-white/40")}
                  >
                    <Settings2 className="w-4 h-4" />
                  </button>
               </div>
            </div>

            {/* Visual Settings Panel */}
            <AnimatePresence>
              {showVisualSettings && (
                <motion.div 
                  initial={{ opacity: 0, scale: 0.95, y: 10 }}
                  animate={{ opacity: 1, scale: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.95, y: 10 }}
                  className="absolute top-24 right-6 w-72 bg-black/90 backdrop-blur-2xl border border-white/10 rounded-2xl p-4 z-50 shadow-2xl flex flex-col max-h-[500px]"
                >
                  <div className="flex items-center justify-between mb-4 shrink-0">
                    <div className="flex items-center gap-2">
                      <Layers className="w-3 h-3 text-emerald-500" />
                      <h3 className="text-[10px] font-bold uppercase tracking-widest text-white/60">Visual Contents</h3>
                    </div>
                    <button onClick={() => {
                      const id = `vis-${Date.now()}`;
                      setVisualContents([...visualContents, { id, name: `Content ${visualContents.length + 1}`, type: 'geometry', shape: 'circle', visible: true, color: '#fff' }]);
                    }} className="p-1.5 hover:bg-white/10 rounded-lg transition-colors text-emerald-500">
                      <Plus className="w-4 h-4" />
                    </button>
                  </div>
                  <div className="flex-1 space-y-3 overflow-y-auto custom-scrollbar pr-2 -mr-2">
                    {visualContents.map(vc => (
                      <div key={vc.id} className="p-3 rounded-xl bg-white/5 border border-white/5 space-y-3 hover:border-white/10 transition-colors">
                        <div className="flex items-center justify-between">
                          <input 
                            value={vc.name}
                            onChange={(e) => setVisualContents(prev => prev.map(curr => curr.id === vc.id ? { ...curr, name: e.target.value } : curr))}
                            className="bg-transparent text-[10px] font-bold uppercase outline-none w-24"
                          />
                          <button onClick={() => setVisualContents(prev => prev.filter(curr => curr.id !== vc.id))} className="text-white/20 hover:text-red-500">
                            <Trash2 className="w-3 h-3" />
                          </button>
                        </div>
                        <div className="grid grid-cols-2 gap-2">
                          <select 
                            value={vc.type}
                            onChange={(e) => setVisualContents(prev => prev.map(curr => curr.id === vc.id ? { ...curr, type: e.target.value as any } : curr))}
                            className="bg-black border border-white/10 rounded px-1 py-0.5 text-[9px] outline-none"
                          >
                            <option value="geometry">Geometry</option>
                            <option value="particles">Particles</option>
                          </select>
                          <select 
                            value={vc.shape}
                            onChange={(e) => setVisualContents(prev => prev.map(curr => curr.id === vc.id ? { ...curr, shape: e.target.value as any } : curr))}
                            className="bg-black border border-white/10 rounded px-1 py-0.5 text-[9px] outline-none"
                          >
                            <option value="circle">Circle</option>
                            <option value="square">Square</option>
                            <option value="triangle">Triangle</option>
                            <option value="pentagon">Pentagon</option>
                            <option value="hexagon">Hexagon</option>
                            <option value="star">Star</option>
                          </select>
                        </div>
                        <div className="flex items-center justify-between">
                           <button 
                            onClick={() => setVisualContents(prev => prev.map(curr => curr.id === vc.id ? { ...curr, visible: !curr.visible } : curr))}
                            className={cn("text-[9px] px-2 py-0.5 rounded border transition-all", vc.visible ? "bg-emerald-500/20 border-emerald-500/40 text-emerald-400" : "border-white/5 text-white/30")}
                           >
                             {vc.visible ? 'VISIBLE' : 'HIDDEN'}
                           </button>
                           <input 
                            type="color" 
                            value={vc.color}
                            onChange={(e) => setVisualContents(prev => prev.map(curr => curr.id === vc.id ? { ...curr, color: e.target.value } : curr))}
                            className="w-4 h-4 bg-transparent border-none cursor-pointer"
                           />
                        </div>
                      </div>
                    ))}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          {/* Curve Editor */}
          <div className="h-80 border-t border-white/5 bg-[#0d0d0d] flex flex-col">
            <div className="h-10 border-b border-white/5 flex items-center justify-between px-4">
              <div className="flex items-center gap-4">
                <span className="text-[10px] font-bold uppercase tracking-widest text-white/30">Editor: {activeCurve.name}</span>
                <div className="flex items-center gap-2">
                  <button 
                    onClick={() => setCurves(prev => prev.map(c => c.id === activeCurveId ? { ...c, interpolation: 'linear' } : c))}
                    className={cn("text-[9px] px-2 py-0.5 rounded border transition-all", activeCurve.interpolation === 'linear' ? "bg-emerald-500/20 border-emerald-500/40 text-emerald-400" : "border-white/5 text-white/30")}
                  >LINEAR</button>
                  <button 
                    onClick={() => setCurves(prev => prev.map(c => c.id === activeCurveId ? { ...c, interpolation: 'monotone' } : c))}
                    className={cn("text-[9px] px-2 py-0.5 rounded border transition-all", activeCurve.interpolation === 'monotone' ? "bg-emerald-500/20 border-emerald-500/40 text-emerald-400" : "border-white/5 text-white/30")}
                  >SMOOTH</button>
                </div>
              </div>

              <div className="flex items-center gap-4">
                <div className="flex items-center gap-2">
                  <span className="text-[9px] text-white/30 uppercase">Nesting</span>
                  <select 
                    value={activeCurve.modulatorId || ''}
                    onChange={(e) => setCurves(prev => prev.map(c => c.id === activeCurveId ? { ...c, modulatorId: e.target.value || undefined } : c))}
                    className="bg-black border border-white/10 rounded px-2 py-0.5 text-[10px] outline-none"
                  >
                    <option value="">None</option>
                    {curves.filter(c => c.id !== activeCurveId).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </div>
              </div>
            </div>

            <div className="flex-1 relative group">
              <CurveCanvas 
                activeCurve={activeCurve} 
                allCurves={curves}
                onAddPoint={(x, y) => addPoint(activeCurveId, x, y)}
                onMovePoint={(id, x, y) => movePoint(activeCurveId, id, x, y)}
                onRemovePoint={(id) => removePoint(activeCurveId, id)}
                currentTime={engine.time}
              />
            </div>
          </div>
        </section>

        {/* Right Sidebar: Module Controls */}
        <aside className="w-64 border-l border-white/5 bg-[#0f0f0f] flex flex-col">
          <div className="p-4 border-b border-white/5">
            <h2 className="text-xs font-bold uppercase tracking-widest text-white/40 mb-4 flex items-center gap-2">
              <Waves className="w-3 h-3" /> Audio Engine
            </h2>
            <div className="space-y-4">
              <ControlGroup label="Global Duration">
                <input 
                  type="range" min="1" max="20" step="0.1" 
                  value={engine.duration} 
                  onChange={(e) => setEngine(prev => ({ ...prev, duration: parseFloat(e.target.value) }))}
                  className="w-full accent-emerald-500"
                />
                <div className="flex justify-between text-[10px] font-mono text-white/30">
                  <span>1s</span>
                  <span className="text-emerald-500">{engine.duration}s</span>
                  <span>20s</span>
                </div>
              </ControlGroup>
            </div>
          </div>

          <div className="p-4 flex-1 overflow-y-auto custom-scrollbar">
            <h2 className="text-xs font-bold uppercase tracking-widest text-white/40 mb-4 flex items-center gap-2">
              <Eye className="w-3 h-3" /> Visual Engine
            </h2>
            <div className="space-y-6">
              <div className="p-3 rounded-xl bg-black/40 border border-white/5">
                <p className="text-[10px] text-white/40 mb-2 uppercase font-mono">Morphological State</p>
                <div className="grid grid-cols-2 gap-2">
                  <StateBadge active={engine.time < 0.2} label="Onset" color="emerald" />
                  <StateBadge active={engine.time >= 0.2 && engine.time < 0.8} label="Continuant" color="blue" />
                  <StateBadge active={engine.time >= 0.8} label="Termination" color="red" />
                </div>
              </div>

              <div className="space-y-4">
                 <ControlGroup label="Nesting Strength">
                    <input 
                      type="range" min="0" max="1" step="0.01" 
                      value={activeCurve.modulatorStrength} 
                      onChange={(e) => setCurves(prev => prev.map(c => c.id === activeCurveId ? { ...c, modulatorStrength: parseFloat(e.target.value) } : c))}
                      className="w-full accent-emerald-500"
                    />
                 </ControlGroup>
                 <ControlGroup label="Nesting Freq">
                    <input 
                      type="range" min="1" max="50" step="1" 
                      value={activeCurve.modulatorFrequency} 
                      onChange={(e) => setCurves(prev => prev.map(c => c.id === activeCurveId ? { ...c, modulatorFrequency: parseInt(e.target.value) } : c))}
                      className="w-full accent-emerald-500"
                    />
                 </ControlGroup>
              </div>
            </div>
          </div>
        </aside>
      </main>

      <style dangerouslySetInnerHTML={{ __html: `
        .custom-scrollbar::-webkit-scrollbar { width: 4px; }
        .custom-scrollbar::-webkit-scrollbar-track { background: transparent; }
        .custom-scrollbar::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); border-radius: 10px; }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.2); }
      `}} />
    </div>
  );
}

// --- Sub-Components ---

function ControlGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <label className="text-[10px] text-white/40 uppercase font-mono tracking-wider">{label}</label>
      {children}
    </div>
  );
}

function StateBadge({ active, label, color }: { active: boolean; label: string; color: 'emerald' | 'blue' | 'red' }) {
  const colors = {
    emerald: active ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30' : 'bg-white/5 text-white/20 border-transparent',
    blue: active ? 'bg-blue-500/20 text-blue-400 border-blue-500/30' : 'bg-white/5 text-white/20 border-transparent',
    red: active ? 'bg-red-500/20 text-red-400 border-red-500/30' : 'bg-white/5 text-white/20 border-transparent',
  };
  return (
    <div className={cn("px-2 py-1 rounded text-[9px] font-bold uppercase border transition-all text-center", colors[color])}>
      {label}
    </div>
  );
}

function CurveCanvas({ activeCurve, allCurves, onAddPoint, onMovePoint, onRemovePoint, currentTime }: { 
  activeCurve: MorphologyCurve; 
  allCurves: MorphologyCurve[];
  onAddPoint: (x: number, y: number) => void;
  onMovePoint: (id: string, x: number, y: number) => void;
  onRemovePoint: (id: string) => void;
  currentTime: number;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);

  const calculateCurveValueLocal = (curveId: string, t: number, curvesList: MorphologyCurve[], depth = 0): number => {
    if (depth > 5) return 0;
    const curve = curvesList.find(c => c.id === curveId);
    if (!curve) return 0;

    const sortedPoints = [...curve.points].sort((a, b) => a.x - b.x);
    
    let baseVal = 0;
    if (curve.interpolation === 'monotone') {
      baseVal = interpolateMonotone(sortedPoints, t);
    } else if (curve.interpolation === 'basis') {
      baseVal = interpolateBasis(sortedPoints, t);
    } else {
      baseVal = interpolateLinear(sortedPoints, t);
    }

    if (curve.modulatorId) {
      const modVal = calculateCurveValueLocal(curve.modulatorId, (t * curve.modulatorFrequency) % 1, curvesList, depth + 1);
      baseVal += (modVal - 0.5) * curve.modulatorStrength;
    }
    return Math.max(0, Math.min(1, baseVal));
  };

  const getPathData = (curve: MorphologyCurve, isNested: boolean) => {
    const samples = isNested ? 200 : 100;
    const points: {x: number, y: number}[] = [];
    for (let i = 0; i <= samples; i++) {
      const t = i / samples;
      const val = isNested 
        ? calculateCurveValueLocal(curve.id, t, allCurves)
        : calculateCurveValueLocal(curve.id, t, allCurves, 6); // Depth 6 disables nesting
      points.push({ x: t * 100, y: (1 - val) * 100 });
    }
    
    const generator = d3.line<{x: number, y: number}>().x(p => p.x).y(p => p.y);
    
    // Since we are sampling the curve ourselves using the interpolation logic,
    // we should use linear line segments between samples to accurately reflect the math.
    return generator(points);
  };

  const handleMouseDown = (e: React.MouseEvent, pointId?: string) => {
    if (pointId) {
      setDraggingId(pointId);
    } else {
      const rect = containerRef.current!.getBoundingClientRect();
      const x = (e.clientX - rect.left) / rect.width;
      const y = 1 - (e.clientY - rect.top) / rect.height;
      onAddPoint(x, y);
    }
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!draggingId) return;
    const rect = containerRef.current!.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = 1 - (e.clientY - rect.top) / rect.height;
    onMovePoint(draggingId, x, y);
  };

  const handleMouseUp = () => setDraggingId(null);

  return (
    <div 
      ref={containerRef}
      className="w-full h-full cursor-crosshair relative overflow-hidden"
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      onMouseDown={(e) => handleMouseDown(e)}
    >
      {/* Grid */}
      <svg className="absolute inset-0 w-full h-full pointer-events-none opacity-5">
        <defs>
          <pattern id="grid" width="10%" height="10%" patternUnits="userSpaceOnUse">
            <path d="M 100 0 L 0 0 0 100" fill="none" stroke="white" strokeWidth="1" />
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#grid)" />
      </svg>

      {/* Playhead */}
      <div 
        className="absolute top-0 bottom-0 w-px bg-emerald-500/40 z-10 pointer-events-none"
        style={{ left: `${currentTime * 100}%` }}
      >
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-1 h-1 bg-emerald-500 rounded-full shadow-[0_0_8px_rgba(16,185,129,1)]" />
      </div>

      {/* All Curves */}
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="absolute inset-0 w-full h-full pointer-events-none">
        {allCurves.map(c => {
          const isActive = c.id === activeCurve.id;
          const hasNesting = !!c.modulatorId;
          return (
            <React.Fragment key={c.id}>
              {/* Base Reference Path (Faint) */}
              <path 
                d={getPathData(c, false) || ''} 
                fill="none" 
                stroke={c.color} 
                strokeWidth="1" 
                strokeOpacity={isActive ? "0.2" : "0.1"}
                strokeDasharray="2,2"
                strokeLinecap="round"
              />
              {/* Main Trajectory Path (Always Visible) */}
              <path 
                d={getPathData(c, true) || ''} 
                fill="none" 
                stroke={c.color} 
                strokeWidth={isActive ? "2.5" : "1.5"} 
                strokeOpacity={isActive ? "1" : "0.4"}
                strokeLinecap="round"
                className={cn(isActive && "drop-shadow-[0_0_8px_rgba(255,255,255,0.3)]")}
              />
            </React.Fragment>
          );
        })}
      </svg>

      {/* Points for Active Curve */}
      {activeCurve.points.map(p => (
        <div
          key={p.id}
          className={cn(
            "absolute w-3 h-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 bg-[#0d0d0d] cursor-move z-20 transition-transform hover:scale-125",
            draggingId === p.id ? "scale-150 border-white" : "border-emerald-500"
          )}
          style={{ left: `${p.x * 100}%`, top: `${(1 - p.y) * 100}%`, borderColor: activeCurve.color }}
          onMouseDown={(e) => {
            e.stopPropagation();
            if (e.button === 2) onRemovePoint(p.id);
            else handleMouseDown(e, p.id);
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            onRemovePoint(p.id);
          }}
        />
      ))}
    </div>
  );
}
