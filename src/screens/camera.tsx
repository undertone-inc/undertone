import React, { useEffect, useMemo, useRef, useState } from 'react';
import { CommonActions } from '@react-navigation/native';
import { ActivityIndicator, Alert, Dimensions, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Ionicons from '@expo/vector-icons/Ionicons';
import Svg, { Defs, Ellipse, Mask, Rect } from 'react-native-svg';
import { CameraType, CameraView, useCameraPermissions } from 'expo-camera';
import { Buffer } from 'buffer';

// jpeg-js is pure JS and works in RN/Expo (no native module)
const jpeg = require('jpeg-js');

type QualityState = {
  ok: boolean;
  message: string;
  debug?: {
    meanLum?: number;
    cast?: number;
    sharp?: number;
    skinRatio?: number;
    faceAreaRatio?: number;
    faceCenterDist?: number;
    faceLumStd?: number;
  };
};

// Selfie framing constants. These are used only for:
// 1) the live-readiness probe, and
// 2) the server preprocessing crop (done in Upload).
const OVAL_CENTER_Y = 0.42;
const OVAL_RX = 0.34;
const OVAL_RY = 0.32;

// Probe settings: a tiny capture used only to decide whether the shutter becomes available.
const PROBE_QUALITY = 0.12;
const PROBE_INTERVAL_MS_OK = 1700;
const PROBE_INTERVAL_MS_BAD = 950;

const { width: W, height: H } = Dimensions.get('window');

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function assessQualityFromBase64Jpeg(base64: string): QualityState {
  try {
    // Ensure Buffer exists (RN sometimes doesn't provide it globally)
    (global as any).Buffer = (global as any).Buffer || Buffer;

    const buf = Buffer.from(base64, 'base64');
    const decoded = jpeg.decode(buf, { useTArray: true });
    const w = decoded?.width ?? 0;
    const h = decoded?.height ?? 0;
    const data: Uint8Array = decoded?.data;

    if (!w || !h || !data) {
      return { ok: false, message: 'Hold still…' };
    }

    const cx = w * 0.5;
    const cy = h * OVAL_CENTER_Y;
    const rx = w * OVAL_RX;
    const ry = h * OVAL_RY;

    // Sample step: keep work bounded.
    const step = clamp(Math.floor(Math.min(w, h) / 160), 2, 8);

    const x0 = clamp(Math.floor(cx - rx), 0, w - 1);
    const x1 = clamp(Math.floor(cx + rx), 0, w - 1);
    const y0 = clamp(Math.floor(cy - ry), 0, h - 1);
    const y1 = clamp(Math.floor(cy + ry), 0, h - 1);

    const gridW = Math.floor((x1 - x0) / step) + 1;
    const gridH = Math.floor((y1 - y0) / step) + 1;
    const gridN = gridW * gridH;

    const inside = new Uint8Array(gridN);
    const skin = new Uint8Array(gridN);
    const lumGrid = new Float32Array(gridN);

    let count = 0;
    let sumLum = 0;
    let sumR = 0;
    let sumG = 0;
    let sumB = 0;

    let dark = 0;
    let bright = 0;
    let skinCount = 0;

    let sharpSum = 0;
    let sharpCount = 0;

    const lumOf = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

    const isSkin = (r: number, g: number, b: number) => {
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const y = 0.299 * r + 0.587 * g + 0.114 * b;
      const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
      const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;

      // Two permissive rules combined:
      // - RGB heuristic (classic-ish)
      // - YCbCr heuristic (often catches more skin tones under mixed lighting)
      const rgbRule =
        r > 45 &&
        g > 18 &&
        b > 12 &&
        r >= g &&
        r >= b &&
        Math.abs(r - g) > 8 &&
        max - min > 12;

      const ycbcrRule = y > 28 && cb >= 75 && cb <= 145 && cr >= 132 && cr <= 190;

      return rgbRule || ycbcrRule;
    };

    let gy = 0;
    for (let y = y0; y <= y1; y += step, gy++) {
      const yn = (y - cy) / ry;
      let gx = 0;

      for (let x = x0; x <= x1; x += step, gx++) {
        const xn = (x - cx) / rx;
        if (xn * xn + yn * yn > 1) continue;

        const gi = gy * gridW + gx;
        inside[gi] = 1;

        const idx = (y * w + x) * 4;
        const r = data[idx] ?? 0;
        const g = data[idx + 1] ?? 0;
        const b = data[idx + 2] ?? 0;

        const lum = lumOf(r, g, b);
        lumGrid[gi] = lum;

        sumLum += lum;
        sumR += r;
        sumG += g;
        sumB += b;
        count++;

        if (lum < 35) dark++;
        if (lum > 225) bright++;

        if (isSkin(r, g, b)) {
          skin[gi] = 1;
          skinCount++;
        }

        // Sharpness proxy (simple local gradient).
        const x2 = x + step;
        const y2 = y + step;
        if (x2 < w && y2 < h) {
          const idxR = (y * w + x2) * 4;
          const idxD = (y2 * w + x) * 4;
          const lumR = lumOf(data[idxR] ?? r, data[idxR + 1] ?? g, data[idxR + 2] ?? b);
          const lumD = lumOf(data[idxD] ?? r, data[idxD + 1] ?? g, data[idxD + 2] ?? b);
          sharpSum += Math.abs(lum - lumR) + Math.abs(lum - lumD);
          sharpCount++;
        }
      }
    }

    if (count < 500) {
      return { ok: false, message: 'Center your face in the oval.' };
    }

    const meanLum = sumLum / count;
    const avgR = sumR / count;
    const avgG = sumG / count;
    const avgB = sumB / count;

    const darkRatio = dark / count;
    const brightRatio = bright / count;
    const skinRatio = skinCount / count;
    const cast = (avgR - avgB) / (meanLum + 1);
    const sharp = sharpCount ? sharpSum / sharpCount : 0;

    // Find largest connected skin blob (helps avoid false-green when there's no face in the oval).
    const visited = new Uint8Array(gridN);

    let bestArea = 0;
    let bestSumX = 0;
    let bestSumY = 0;
    let bestMinX = 0;
    let bestMaxX = 0;
    let bestMinY = 0;
    let bestMaxY = 0;
    let bestLumSum = 0;
    let bestLum2Sum = 0;

    const neighbors = (i: number) => {
      const out: number[] = [];
      const x = i % gridW;
      const y = Math.floor(i / gridW);
      if (x > 0) out.push(i - 1);
      if (x + 1 < gridW) out.push(i + 1);
      if (y > 0) out.push(i - gridW);
      if (y + 1 < gridH) out.push(i + gridW);
      return out;
    };

    for (let i = 0; i < gridN; i++) {
      if (!inside[i] || !skin[i] || visited[i]) continue;

      const q: number[] = [i];
      visited[i] = 1;

      let area = 0;
      let sumXc = 0;
      let sumYc = 0;
      let minXc = Infinity;
      let maxXc = -Infinity;
      let minYc = Infinity;
      let maxYc = -Infinity;
      let lumSum = 0;
      let lum2Sum = 0;

      while (q.length) {
        const cur = q.pop() as number;
        const gx = cur % gridW;
        const gy2 = Math.floor(cur / gridW);
        const px = x0 + gx * step;
        const py = y0 + gy2 * step;

        area++;
        sumXc += px;
        sumYc += py;
        minXc = Math.min(minXc, px);
        maxXc = Math.max(maxXc, px);
        minYc = Math.min(minYc, py);
        maxYc = Math.max(maxYc, py);

        const l = lumGrid[cur];
        lumSum += l;
        lum2Sum += l * l;

        const ns = neighbors(cur);
        for (let k = 0; k < ns.length; k++) {
          const ni = ns[k];
          if (visited[ni]) continue;
          if (!inside[ni] || !skin[ni]) continue;
          visited[ni] = 1;
          q.push(ni);
        }
      }

      if (area > bestArea) {
        bestArea = area;
        bestSumX = sumXc;
        bestSumY = sumYc;
        bestMinX = minXc;
        bestMaxX = maxXc;
        bestMinY = minYc;
        bestMaxY = maxYc;
        bestLumSum = lumSum;
        bestLum2Sum = lum2Sum;
      }
    }

    const faceAreaRatio = bestArea ? bestArea / count : 0;
    const faceCx = bestArea ? bestSumX / bestArea : cx;
    const faceCy = bestArea ? bestSumY / bestArea : cy;
    const faceCenterDist = bestArea
      ? Math.sqrt(Math.pow((faceCx - cx) / rx, 2) + Math.pow((faceCy - cy) / ry, 2))
      : 1;

    const bboxW = bestArea ? bestMaxX - bestMinX + step : 0;
    const bboxH = bestArea ? bestMaxY - bestMinY + step : 0;
    const bboxWn = bboxW / (2 * rx);
    const bboxHn = bboxH / (2 * ry);
    const faceLumMean = bestArea ? bestLumSum / bestArea : 0;
    const faceLumStd = bestArea
      ? Math.sqrt(Math.max(0, bestLum2Sum / bestArea - faceLumMean * faceLumMean))
      : 0;

    // Gates (aim: reliable undertone capture without being overly strict)
    // We hard-block only when the face isn't properly framed or the photo is extremely unusable.
    // Mild lighting/cast issues are treated as tips (still allow capture).

    const extremeDark = meanLum < 45 || darkRatio > 0.42;
    const extremeBright = meanLum > 215 || brightRatio > 0.36;
    const extremeBlurry = sharp < 12;

    const moderateDark = meanLum < 60 || darkRatio > 0.28;
    const moderateBright = meanLum > 200 || brightRatio > 0.26;
    const moderateBlurry = sharp < 16;
    const castStrong = Math.abs(cast) > 0.22;

    // Face-in-oval heuristics (slightly relaxed)
    const notEnoughSkin = skinRatio < 0.14;
    const noDominantBlob = faceAreaRatio < 0.06;
    const offCenter = faceCenterDist > 0.56;
    const tooFar = bboxWn < 0.28 || bboxHn < 0.28;
    const tooClose = bboxWn > 0.98 || bboxHn > 0.98;
    const tooUniform = faceLumStd < 5;

    const block: string[] = [];
    const tips: string[] = [];

    if (notEnoughSkin || noDominantBlob || offCenter || tooUniform) block.push('center your face');
    if (tooFar) block.push('move closer');
    if (tooClose) block.push('move back');

    if (extremeDark) block.push('find brighter light');
    if (extremeBright) block.push('avoid harsh light');
    if (extremeBlurry) block.push('hold still');

    if (!extremeDark && moderateDark) tips.push('brighter light improves accuracy');
    if (!extremeBright && moderateBright) tips.push('avoid harsh direct light');
    if (castStrong) tips.push('neutral light improves accuracy');
    if (!extremeBlurry && moderateBlurry) tips.push('hold still');

    const ok = block.length === 0;
    const message = ok ? (tips.length ? `Ready • ${tips[0]}` : 'Ready') : `Adjust: ${block.slice(0, 2).join(' + ')}`;

    return {
      ok,
      message,
      debug: {
        meanLum,
        cast,
        sharp,
        skinRatio,
        faceAreaRatio,
        faceCenterDist,
        faceLumStd,
      },
    };
  } catch {
    return { ok: false, message: 'Hold still…' };
  }
}

export default function CameraScreen({ navigation }: any) {
  const cameraRef = useRef<CameraView | null>(null);
  const probeTimerRef = useRef<any>(null);
  const inFlightRef = useRef<Promise<any> | null>(null);
  const mountedRef = useRef(true);
  const probeEnabledRef = useRef(true);
  const submittedRef = useRef(false);

  const [permission, requestPermission] = useCameraPermissions();
  const [cameraReady, setCameraReady] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [facing, setFacing] = useState<CameraType>('front');
  const [cameraKey, setCameraKey] = useState(0);

  const [quality, setQuality] = useState<QualityState>({ ok: false, message: 'Center your face in the oval.' });
  const qualityOkRef = useRef(false);
  useEffect(() => {
    qualityOkRef.current = Boolean(quality.ok);
  }, [quality.ok]);

  const insets = useSafeAreaInsets();
  const topBarTop = Math.max(insets.top + 26, 72);
  const bottomPad = Math.max(insets.bottom + 52, 70);

  const oval = useMemo(() => {
    const rx = Math.min(W * 0.36, 180);
    const ry = Math.min(H * 0.22, 220);
    const cx = W / 2;
    const cy = H * OVAL_CENTER_Y;
    return { cx, cy, rx, ry };
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    submittedRef.current = false;
    (global as any).Buffer = (global as any).Buffer || Buffer;
    return () => {
      mountedRef.current = false;
      if (probeTimerRef.current) {
        clearTimeout(probeTimerRef.current);
        probeTimerRef.current = null;
      }
      probeEnabledRef.current = false;
    };
  }, []);

  const stopProbe = () => {
    probeEnabledRef.current = false;
    if (probeTimerRef.current) {
      clearTimeout(probeTimerRef.current);
      probeTimerRef.current = null;
    }
  };

  const scheduleProbe = (ms?: number) => {
    if (!probeEnabledRef.current) return;
    if (probeTimerRef.current) {
      clearTimeout(probeTimerRef.current);
      probeTimerRef.current = null;
    }
    const delay = typeof ms === 'number' ? ms : (qualityOkRef.current ? PROBE_INTERVAL_MS_OK : PROBE_INTERVAL_MS_BAD);
    probeTimerRef.current = setTimeout(runProbe, delay);
  };

  const runProbe = async () => {
    if (!mountedRef.current) return;
    if (!probeEnabledRef.current) return;
    if (!permission?.granted || !cameraReady || capturing) {
      scheduleProbe();
      return;
    }
    if (!cameraRef.current) {
      scheduleProbe();
      return;
    }
    if (inFlightRef.current) {
      scheduleProbe();
      return;
    }

    try {
      inFlightRef.current = (cameraRef.current as any).takePictureAsync({
        quality: PROBE_QUALITY,
        base64: true,
        skipProcessing: true,
        shutterSound: false,
        exif: false,
      });

      const pic = await inFlightRef.current;
      const base64 = pic?.base64;
      if (typeof base64 === 'string' && base64.length > 1000) {
        const q = assessQualityFromBase64Jpeg(base64);
        if (mountedRef.current) setQuality(q);
      }
    } catch {
      // If probing fails, don't crash; try again later.
    } finally {
      inFlightRef.current = null;
      scheduleProbe();
    }
  };

  useEffect(() => {
    // Restart probe when camera becomes ready / toggles / remounts.
    if (permission?.granted && cameraReady && !capturing) {
      probeEnabledRef.current = true;
      scheduleProbe(450);
    }
    return () => {
      // no-op
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [permission?.granted, cameraReady, facing, cameraKey]);

  const close = () => {
    stopProbe();
    try {
      if (navigation?.canGoBack?.()) {
        navigation.goBack();
      } else {
        navigation.navigate('Tabs');
      }
    } catch {
      try {
        navigation.navigate('Tabs');
      } catch {
        // ignore
      }
    }
  };

  const toggleFacing = () => {
    if (capturing) return;
    stopProbe();
    setCameraReady(false);
    setQuality({ ok: false, message: 'Center your face in the oval.' });
    setFacing((prev) => (prev === 'front' ? 'back' : 'front'));
    setCameraKey((k) => k + 1);
  };

  const waitForIdle = async (maxMs = 1600) => {
    const start = Date.now();
    while (inFlightRef.current && Date.now() - start < maxMs) {
      await sleep(50);
    }
    return !inFlightRef.current;
  };

  const takePhoto = async () => {
    if (capturing) return;
    if (!quality.ok) return;
    if (!cameraRef.current) return;

    stopProbe();
    setCapturing(true);

    try {
      const idle = await waitForIdle(1600);
      if (!idle) {
        Alert.alert('Hold still', 'Camera is still focusing. Try again.');
        return;
      }

      // Give the camera a tiny beat to settle.
      await sleep(60);

      const opts: any = {
        // Capture at max quality, then normalize/compress in Upload.
        // For color analysis, it's important the final capture is *processed*
        // (orientation + camera pipeline) so server-side JPEG decode/crop is consistent.
        quality: 1,
        base64: false,
        skipProcessing: false,
        exif: false,
        shutterSound: false,
      };

      let pic: any = null;
      let lastErr: any = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          inFlightRef.current = (cameraRef.current as any).takePictureAsync(opts);
          pic = await inFlightRef.current;
          break;
        } catch (e: any) {
          lastErr = e;
          const msg = String(e?.message || e || '').toLowerCase();
          const retryable = msg.includes('busy') || msg.includes('in progress') || msg.includes('not ready');
          if (attempt < 2 && retryable) {
            await sleep(250);
            continue;
          }
          throw e;
        } finally {
          inFlightRef.current = null;
        }
      }

      const uri: string | undefined = pic?.uri;
      if (!uri) {
        throw lastErr || new Error('Photo capture failed');
      }

      const picked = {
        uri,
        fileName: `face_${Date.now()}.jpg`,
        mimeType: 'image/jpeg',
        source: 'camera',
        width: pic?.width,
        height: pic?.height,
      };

      // Send the captured photo to Upload and *guarantee* the modal closes.
      // Using a stack reset avoids the common bug where navigate('Tabs') keeps the Camera modal on-screen.
      submittedRef.current = true;

      try {
        navigation.dispatch(
          CommonActions.reset({
            index: 0,
            routes: [
              {
                name: 'Tabs',
                state: {
                  index: 0,
                  routes: [
                    { name: 'Upload', params: { capturedPhoto: picked } },
                    { name: 'Clients' },
						{ name: 'YourKit' },
                    { name: 'Account' },
                  ],
                },
              },
            ],
          })
        );
      } catch {
        // Last-resort fallback
        try {
          navigation.navigate('Tabs', { screen: 'Upload', params: { capturedPhoto: picked }, merge: true });
          navigation.goBack();
        } catch {
          // ignore
        }
      }
    } catch (e: any) {
      const msg = String(e?.message || e || 'Photo capture failed');
      Alert.alert('Photo capture failed', msg);

      // If the camera gets into a weird state after errors, force a remount.
      setCameraReady(false);
      setQuality({ ok: false, message: 'Center your face in the oval.' });
      setCameraKey((k) => k + 1);
    } finally {
      if (mountedRef.current) setCapturing(false);

      // If we didn't successfully submit (or if the user is still on this screen), restart probing.
      if (mountedRef.current && !submittedRef.current) {
        probeEnabledRef.current = true;
        scheduleProbe(650);
      }
    }
  };

  if (!permission) {
    return (
      <View style={styles.loadingScreen}>
        <ActivityIndicator />
      </View>
    );
  }

  if (!permission.granted) {
    return (
      <View style={styles.permissionScreen}>
        <Text style={styles.permissionTitle}>Camera access needed</Text>
        <Text style={styles.permissionText}>We use your camera to scan your face for undertone analysis.</Text>
        <TouchableOpacity style={styles.permissionButton} onPress={requestPermission}>
          <Text style={styles.permissionButtonText}>Allow camera</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.permissionClose} onPress={close}>
          <Text style={styles.permissionCloseText}>Not now</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <CameraView
        key={`cam_${cameraKey}_${facing}`}
        ref={cameraRef}
        style={StyleSheet.absoluteFill}
        facing={facing}
        active
        animateShutter={false}
        onCameraReady={() => setCameraReady(true)}
      />

      {/* Dark overlay + oval cutout + red/green border */}
      <View pointerEvents="none" style={StyleSheet.absoluteFill}>
        <Svg width={W} height={H}>
          <Defs>
            <Mask id="mask">
              <Rect x="0" y="0" width={W} height={H} fill="white" />
              <Ellipse cx={oval.cx} cy={oval.cy} rx={oval.rx} ry={oval.ry} fill="black" />
            </Mask>
          </Defs>

          <Rect x="0" y="0" width={W} height={H} fill="rgba(0,0,0,0.55)" mask="url(#mask)" />
          <Ellipse
            cx={oval.cx}
            cy={oval.cy}
            rx={oval.rx}
            ry={oval.ry}
            fill="transparent"
            stroke={quality.ok ? '#22c55e' : '#ef4444'}
            strokeWidth={3}
          />
        </Svg>
      </View>

      {/* Top bar */}
      <View style={[styles.topBar, { top: topBarTop }]}> 
        <TouchableOpacity style={styles.topButton} onPress={close} accessibilityRole="button">
          <Ionicons name="close" size={22} color="#ffffff" />
        </TouchableOpacity>
        <View style={{ flex: 1 }} />
        <View style={styles.badge}>
          <Text style={styles.badgeText}>{capturing ? 'Saving…' : quality.message}</Text>
        </View>
      </View>

      {/* Bottom controls */}
      <View style={[styles.bottomBar, { paddingBottom: bottomPad }]}> 
        <View style={styles.bottomRow}>
          <TouchableOpacity
            style={styles.utilityButton}
            onPress={toggleFacing}
            disabled={capturing}
            accessibilityRole="button"
          >
            <Ionicons name="camera-reverse-outline" size={22} color="#ffffff" />
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.shutter, (!quality.ok || capturing) && styles.shutterDisabled]}
            onPress={takePhoto}
            disabled={!quality.ok || capturing}
            accessibilityRole="button"
          >
            {capturing ? <ActivityIndicator color="#111827" /> : <Ionicons name="camera" size={22} color="#111827" />}
          </TouchableOpacity>

          <View style={styles.utilitySpacer} />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  loadingScreen: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#000000',
  },
  permissionScreen: {
    flex: 1,
    padding: 24,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#0b0b0b',
  },
  permissionTitle: {
    color: '#ffffff',
    fontSize: 20,
    fontWeight: '700',
    marginBottom: 8,
  },
  permissionText: {
    color: 'rgba(255,255,255,0.75)',
    fontSize: 14,
    textAlign: 'center',
    marginBottom: 18,
    lineHeight: 20,
  },
  permissionButton: {
    backgroundColor: '#ffffff',
    borderRadius: 999,
    paddingVertical: 12,
    paddingHorizontal: 18,
  },
  permissionButtonText: {
    color: '#111827',
    fontSize: 14,
    fontWeight: '700',
  },
  permissionClose: {
    marginTop: 14,
    padding: 10,
  },
  permissionCloseText: {
    color: 'rgba(255,255,255,0.75)',
    fontSize: 13,
    fontWeight: '600',
  },
  container: {
    flex: 1,
    backgroundColor: '#000000',
  },
  topBar: {
    position: 'absolute',
    top: 56,
    left: 14,
    right: 14,
    flexDirection: 'row',
    alignItems: 'center',
  },
  topButton: {
    width: 40,
    height: 40,
    borderRadius: 999,
    backgroundColor: 'rgba(0,0,0,0.35)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  badge: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
  badgeText: {
    color: '#ffffff',
    fontSize: 12,
    fontWeight: '700',
  },
  bottomBar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    paddingHorizontal: 18,
  },
  bottomRow: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  utilityButton: {
    width: 44,
    height: 44,
    borderRadius: 999,
    backgroundColor: 'rgba(0,0,0,0.35)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  utilitySpacer: {
    width: 44,
    height: 44,
  },
  shutter: {
    width: 64,
    height: 64,
    borderRadius: 999,
    backgroundColor: '#ffffff',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.35)',
  },
  shutterDisabled: {
    opacity: 0.5,
  },
});