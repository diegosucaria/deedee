'use client';

import { useEffect } from 'react';

// iOS Safari ignores `user-scalable=no` in the viewport meta tag (by design —
// Apple reverted that in iOS 10 for accessibility). To actually block pinch
// and double-tap zoom inside the app, we have to swallow the gesture events
// ourselves. CSS `touch-action: manipulation` (globals.css) handles the
// double-tap half; this handles the pinch half.
export default function ZoomLock() {
  useEffect(() => {
    const block = (e) => e.preventDefault();
    const blockMultiTouch = (e) => {
      if (e.touches && e.touches.length > 1) e.preventDefault();
    };

    document.addEventListener('gesturestart', block);
    document.addEventListener('gesturechange', block);
    document.addEventListener('gestureend', block);
    document.addEventListener('touchmove', blockMultiTouch, { passive: false });

    return () => {
      document.removeEventListener('gesturestart', block);
      document.removeEventListener('gesturechange', block);
      document.removeEventListener('gestureend', block);
      document.removeEventListener('touchmove', blockMultiTouch);
    };
  }, []);

  return null;
}
