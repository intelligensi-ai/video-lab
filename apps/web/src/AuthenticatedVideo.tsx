import React, { useEffect, useState } from 'react';
import { fetchGenerationOutput } from './api.js';

export function useAuthenticatedVideo(downloadUrl?: string) {
  const [objectUrl, setObjectUrl] = useState<string>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!downloadUrl) {
      setObjectUrl(undefined);
      setError(undefined);
      return;
    }
    let active = true;
    let createdUrl: string | undefined;
    fetchGenerationOutput(downloadUrl)
      .then((blob) => {
        if (!active) return;
        createdUrl = URL.createObjectURL(blob);
        setObjectUrl(createdUrl);
        setError(undefined);
      })
      .catch((cause) => {
        if (!active) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      active = false;
      if (createdUrl) URL.revokeObjectURL(createdUrl);
    };
  }, [downloadUrl]);

  return { objectUrl, error };
}

export function AuthenticatedVideo({ downloadUrl, className }: { downloadUrl: string; className?: string }) {
  const video = useAuthenticatedVideo(downloadUrl);
  if (video.error) return <p className="error">Video retrieval failed: {video.error}</p>;
  if (!video.objectUrl) return <div className="thumb big">Retrieving completed video…</div>;
  return <video className={className} src={video.objectUrl} controls />;
}
