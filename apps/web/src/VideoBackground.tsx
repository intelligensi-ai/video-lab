import React from 'react';

const VideoBackground: React.FC = () => {
  return (
    <div style={{
      position: 'absolute',
      top: 0,
      left: 0,
      width: '100vw',
      height: '100vh',
      zIndex: 0,
      overflow: 'hidden',
      pointerEvents: 'none', // Let clicks pass through to any underlying layers if needed
    }}>
      <video
        autoPlay
        loop
        muted
        playsInline
        src="/Video-lab-startup-video.mp4"
        style={{
          width: '100%',
          height: '100%',
          objectFit: 'cover',
          opacity: 0.85,
          filter: 'blur(8px) brightness(1.1)', // Blur to keep focus on UI, brighten slightly for light theme
          transform: 'scale(1.05)', // Prevent blur edges from showing
        }}
      />
    </div>
  );
};

export default VideoBackground;
