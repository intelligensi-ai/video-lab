import React, { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getGallery } from "./api.js";
import VideoBackground from "./VideoBackground";
import TypewriterTitle from "./TypewriterTitle";
import type { Generation } from "@video-lab/contracts";
import "./MinimalUI.css";

export default function MinimalUI() {
  const [prompt, setPrompt] = useState("");
  const [isRecording, setIsRecording] = useState(false);
  
  // Advanced Settings
  const [aspectRatio, setAspectRatio] = useState("16:9");
  const [model, setModel] = useState("ltx-2.5");
  const [cameraMotion, setCameraMotion] = useState("static");
  const [duration, setDuration] = useState(5);
  const [cfgScale, setCfgScale] = useState(7.5);
  const [showNegativePrompt, setShowNegativePrompt] = useState(false);
  const [negativePrompt, setNegativePrompt] = useState("");
  const [showGallery, setShowGallery] = useState(false);
  const [activePopup, setActivePopup] = useState<string | null>(null);

  const galleryQuery = useQuery({
    queryKey: ["gallery"],
    queryFn: getGallery,
  });

  const handleVoiceInput = () => {
    if (isRecording) {
      setIsRecording(false);
    } else {
      setIsRecording(true);
      setTimeout(() => {
        setPrompt((prev) => prev + (prev ? " " : "") + "A cinematic sunset over a futuristic city");
        setIsRecording(false);
      }, 2000);
    }
  };

  const handleGenerate = () => {
    const payload = {
      prompt,
      aspectRatio,
      model,
      duration,
      cfgScale
    };
    console.log("Generating video with payload:", payload);
    alert("Generation started! Check console for payload.");
  };

  return (
    <div className="dock-layout">
      {/* Live Video Background */}
      <VideoBackground />

      {/* Global Blueprint Grid */}
      <div className="global-grid-overlay"></div>

      <div className="workspace-container">
        {/* LEFT PANEL */}
        <aside className="floating-panel left-panel">
          <div className="panel-top-decoration"></div>
          
          <div style={{ marginBottom: '1rem' }}>
            <img src="/intelligensi-logo.png" alt="Intelligensi Logo" style={{ height: '32px' }} />
          </div>
          
          <TypewriterTitle 
            text="Video Generation" 
            icon={
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{marginRight: '8px', verticalAlign: 'text-bottom', color: '#FF6B6B'}}>
                <polygon points="23 7 16 12 23 17 23 7"></polygon>
                <rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect>
              </svg>
            }
          />
          
          <div className="prompt-container">
            <div style={{display: 'flex', justifyContent: 'space-between', marginBottom: '0.25rem'}}>
              <span className="setting-label">Prompt</span>
              <label className="toggle-label" style={{fontSize: '0.75rem'}}>
                <input type="checkbox" checked={showNegativePrompt} onChange={(e) => setShowNegativePrompt(e.target.checked)} /> Negative
              </label>
            </div>
            <textarea 
              className="prompt-textarea"
              placeholder="E.g., A cinematic sunset over a futuristic city..."
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
            />
            <button 
              className={`voice-btn ${isRecording ? 'recording' : ''}`} 
              onClick={handleVoiceInput}
              title="Voice to Text"
              aria-label="Voice input"
            >
              🎤
            </button>
            {showNegativePrompt && (
              <textarea 
                className="prompt-textarea negative-prompt"
                placeholder="What to exclude (e.g., blurry, distorted, low resolution)..."
                value={negativePrompt}
                onChange={(e) => setNegativePrompt(e.target.value)}
                style={{marginTop: '0.5rem', height: '60px'}}
              />
            )}
          </div>

          <div className="dense-settings">
            <div className="setting-group">
              <span className="setting-label">Aspect Ratio</span>
              <div className="aspect-ratio-selector">
                <button className={`ar-btn ${aspectRatio === '16:9' ? 'active' : ''}`} onClick={() => setAspectRatio('16:9')}>
                  <span className="ar-icon landscape"></span>
                  <span className="ar-label">16:9</span>
                </button>
                <button className={`ar-btn ${aspectRatio === '9:16' ? 'active' : ''}`} onClick={() => setAspectRatio('9:16')}>
                  <span className="ar-icon portrait"></span>
                  <span className="ar-label">9:16</span>
                </button>
                <button className={`ar-btn ${aspectRatio === '1:1' ? 'active' : ''}`} onClick={() => setAspectRatio('1:1')}>
                  <span className="ar-icon square"></span>
                  <span className="ar-label">1:1</span>
                </button>
              </div>
            </div>

            <div style={{display: 'flex', gap: '1rem'}}>
              <div className="setting-group" style={{flex: 1}}>
                <span className="setting-label">Model</span>
                <select className="os-select compact" value={model} onChange={e => setModel(e.target.value)}>
                  <option value="ltx-2.5">LTX 2.5</option>
                  <option value="ltx-2.3">LTX 2.3</option>
                  <option value="cinematic-pro">Cinema Pro</option>
                </select>
              </div>
              <div className="setting-group" style={{flex: 1}}>
                <span className="setting-label">Camera</span>
                <select className="os-select compact" value={cameraMotion} onChange={e => setCameraMotion(e.target.value)}>
                  <option value="static">Static</option>
                  <option value="pan_left">Pan Left</option>
                  <option value="zoom_in">Zoom In</option>
                  <option value="orbit">Orbit</option>
                </select>
              </div>
            </div>

            <div className="setting-group" style={{marginTop: '0.5rem'}}>
              <div style={{display: 'flex', justifyContent: 'space-between'}}>
                <span className="setting-label">Duration</span>
                <span className="setting-value">{duration}s</span>
              </div>
              <input 
                type="range" 
                className="os-range custom-slider pink" 
                min="2" max="15" 
                value={duration} 
                onChange={e => setDuration(parseInt(e.target.value))} 
              />
              <div style={{display: 'flex', justifyContent: 'space-between', fontSize: '0.7rem', color: '#9ca3af', marginTop: '-0.2rem'}}>
                <span>2s</span>
                <span>15s</span>
              </div>
            </div>

            <div className="setting-group">
              <div style={{display: 'flex', justifyContent: 'space-between'}}>
                <span className="setting-label">CFG Scale</span>
                <span className="setting-value">{cfgScale}</span>
              </div>
              <input 
                type="range" 
                className="os-range custom-slider cyan" 
                min="1" max="20" step="0.5"
                value={cfgScale} 
                onChange={e => setCfgScale(parseFloat(e.target.value))} 
              />
              <div style={{display: 'flex', justifyContent: 'space-between', fontSize: '0.7rem', color: '#9ca3af', marginTop: '-0.2rem'}}>
                <span>1</span>
                <span>20</span>
              </div>
            </div>
          </div>

          <div className="panel-footer">
             <button className="generate-btn" onClick={handleGenerate}>
               ✨ Generate Video
             </button>
             <div style={{textAlign: 'center', fontSize: '0.75rem', color: '#6b7280', marginTop: '0.75rem'}}>
               Estimated cost: 5 credits
             </div>
          </div>
        </aside>

        {/* CENTER PANEL */}
        <main className="floating-panel center-panel">
          <div className="panel-top-decoration"></div>
          
          <div style={{ display: 'grid', gridTemplateColumns: '1fr auto 1fr', alignItems: 'center', marginTop: 'calc(32px + 1rem)', marginBottom: '1rem', position: 'relative', zIndex: 2 }}>
            <div style={{ justifySelf: 'start' }}>
              <TypewriterTitle 
                text="Video Preview" 
              icon={
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{marginRight: '8px', verticalAlign: 'text-bottom', color: '#4facfe'}}>
                  <rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18"></rect>
                  <line x1="7" y1="2" x2="7" y2="22"></line>
                  <line x1="17" y1="2" x2="17" y2="22"></line>
                  <line x1="2" y1="12" x2="22" y2="12"></line>
                  <line x1="2" y1="7" x2="7" y2="7"></line>
                  <line x1="2" y1="17" x2="7" y2="17"></line>
                  <line x1="17" y1="17" x2="22" y2="17"></line>
                  <line x1="17" y1="7" x2="22" y2="7"></line>
                </svg>
              }
            />
            </div>
            
            <div className="video-specs-toolbar" style={{ justifySelf: 'center' }}>
              <span className="spec-badge">4K HDR</span>
              <span className="spec-badge">60FPS</span>
              <span className="spec-badge">H.265</span>
            </div>
            
            <div className="video-telemetry" style={{ marginBottom: 0, padding: '0.4rem 0.75rem', justifySelf: 'end' }}>
              <div className="telemetry-item">
              <span className="tech-label">SIGNAL</span>
              <div className="mini-waveform">
                <span className="bar"></span>
                <span className="bar"></span>
                <span className="bar"></span>
                <span className="bar"></span>
                <span className="bar"></span>
              </div>
            </div>
            <div className="telemetry-divider"></div>
            <div className="telemetry-item">
              <span className="tech-label">NODE</span>
              <span className="tech-value">AX-7</span>
            </div>
            <div className="telemetry-divider"></div>
            <div className="telemetry-item">
              <span className="tech-label">STATUS</span>
              <span className="tech-value status-blink">AWAITING INPUT</span>
            </div>
          </div>
        </div>

          <div className="video-player-card">
            <div className="video-container">
              <video 
                src="/Video-lab-startup-video.mp4" 
                autoPlay 
                loop 
                muted 
                playsInline
                style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: '14px' }}
              />
              <div style={{ position: 'absolute', bottom: '1.5rem', left: '0', width: '100%', textAlign: 'center' }}>
                 <span style={{ backgroundColor: 'rgba(255,255,255,0.85)', backdropFilter: 'blur(10px)', padding: '0.5rem 1rem', borderRadius: '20px', color: '#FF6B6B', fontWeight: 600, fontSize: '0.85rem', boxShadow: '0 4px 12px rgba(0,0,0,0.1)' }}>
                   ✨ Awaiting your prompt...
                 </span>
              </div>
            </div>
            
            <div className="video-actions-row">
              <div className="playback-controls">
                <button className="play-btn">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
                </button>
                <div className="playback-timeline">
                  <div className="timeline-progress"></div>
                </div>
                <span className="timecode">00:00 / 00:05</span>
              </div>
              
              <div className="video-actions">
                <button className="action-btn">♡ Like</button>
                <button className="action-btn">Share</button>
                <button className="action-btn primary-action">Download</button>
              </div>
            </div>
          </div>
        </main>

        {/* RIGHT PANEL - SELF ADJUSTABLE */}
        {showGallery && (
          <aside className="floating-panel right-panel">
            <div className="panel-top-decoration"></div>
            <h2 className="panel-title">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{marginRight: '8px', verticalAlign: 'text-bottom', color: '#f59e0b'}}>
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
                <circle cx="8.5" cy="8.5" r="1.5"></circle>
                <polyline points="21 15 16 10 5 21"></polyline>
              </svg>
              Project Gallery
              <button className="close-gallery-btn" onClick={() => setShowGallery(false)}>✕</button>
            </h2>
            <div className="gallery-grid">
              {galleryQuery.isLoading && <p>Loading gallery...</p>}
              {galleryQuery.data?.items.map((item: Generation) => (
                <div key={item.id} className="gallery-item">
                  <img 
                    src={item.output?.downloadUrl || "https://placehold.co/600x400?text=..."} 
                    alt="Thumbnail" 
                    className="gallery-thumb"
                  />
                  <div className="gallery-info">
                    <div className="gallery-title">{item.prompt || "Untitled generation"}</div>
                  </div>
                </div>
              ))}
            </div>
          </aside>
        )}
      </div>

      {/* MAC OS DOCK */}
      <div className="mac-dock-container">
        <div className="mac-dock">
          <button className="dock-item active">
            <span className="dock-icon">🏠</span>
            <span className="dock-label">Home</span>
          </button>
          
          <div style={{ position: 'relative' }}>
            <button className={`dock-item ${showGallery ? 'active' : ''}`} onClick={() => {
              setShowGallery(!showGallery);
              setActivePopup(null);
            }}>
              <span className="dock-icon">🖼️</span>
              <span className="dock-label">Gallery</span>
            </button>
          </div>

          <button className="dock-item">
            <span className="dock-icon">🎬</span>
            <span className="dock-label">Studio</span>
          </button>

          <button className="dock-item">
            <span className="dock-icon">📄</span>
            <span className="dock-label">Templates</span>
          </button>

          <div style={{ position: 'relative' }}>
            <button 
              className={`dock-item ${activePopup === 'settings' ? 'active' : ''}`} 
              onClick={() => setActivePopup(activePopup === 'settings' ? null : 'settings')}
            >
              <span className="dock-icon">⚙️</span>
              <span className="dock-label">Settings</span>
            </button>
            {activePopup === 'settings' && (
              <div className="dock-popup-menu">
                <button className="dock-popup-item">Appearance</button>
                <button className="dock-popup-item">Preferences</button>
                <button className="dock-popup-item">API Keys</button>
              </div>
            )}
          </div>

          <div style={{ position: 'relative' }}>
            <button 
              className={`dock-item profile-item ${activePopup === 'profile' ? 'active' : ''}`}
              onClick={() => setActivePopup(activePopup === 'profile' ? null : 'profile')}
            >
              <img src="https://placehold.co/40x40/FF6B6B/white?text=VL" alt="Profile" className="profile-pic" />
              <span className="dock-label">Profile</span>
            </button>
            {activePopup === 'profile' && (
              <div className="dock-popup-menu">
                <button className="dock-popup-item">My Account</button>
                <button className="dock-popup-item">Billing & Credits</button>
                <div className="dock-popup-divider"></div>
                <button className="dock-popup-item text-red">Sign Out</button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
