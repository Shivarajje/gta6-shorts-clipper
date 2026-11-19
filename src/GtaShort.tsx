import React, { useMemo } from 'react';
import {
  AbsoluteFill,
  Interactive,
  OffthreadVideo,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import { z } from 'zod';
import { zColor, zTextarea } from '@remotion/zod-types';
import { Caption, createTikTokStyleCaptions } from '@remotion/captions';
import { loadFont } from '@remotion/google-fonts/Montserrat';
import { useAudioData, visualizeAudio } from '@remotion/media-utils';

const { fontFamily } = loadFont('normal', {
  weights: ['800', '900'],
});

export type CaptionItem = Caption & {
  speakerId?: number;
  color?: string;
  fromMs?: number;
  toMs?: number;
};

export const DEFAULT_CHARACTER_COLORS = [
  '#00F0FF', // Jason / Character 1 (Electric Cyan)
  '#FF2A85', // Lucia / Character 2 (Hot Pink)
  '#FFE600', // Police / Warning / Shouting (Electric Yellow)
  '#00FF66', // Friend / Sidekick / NPC (Neon Lime)
  '#B026FF', // Rival / Boss (Electric Purple)
  '#FF6B00', // Dispatcher / Alternate (Blaze Orange)
];

export const GtaShortSchema = z.object({
  clipFolder: z.string().describe('Clip Folder Name in public/clips/').default('clip_1'),
  hookText: z.string().describe('Hook Headline Banner (First 3.5s)').default('HE DID NOT SEE THIS COMING'),
  showHook: z.boolean().describe('Show Hook Headline Banner').default(true),
  showSubtitles: z.boolean().describe('Show Subtitles / Captions').default(true),
  hasFacecam: z.boolean().describe('Split Facecam Mode (Top Cam / Bottom Game)').default(false),
  facecamBox: z
    .object({
      x: z.number().default(1380),
      y: z.number().default(60),
      width: z.number().default(480),
      height: z.number().default(270),
    })
    .describe('Facecam Crop Box (x, y, width, height)'),
  facecamSplitPercent: z.number().min(15).max(60).describe('Facecam Top Height %').default(32),
  facecamOffsetY: z.number().min(-300).max(300).describe('Facecam Vertical Shift (px)').default(0),
  facecamZoom: z.number().min(0.5).max(2.5).describe('Facecam Zoom Factor').default(1.0),
  gameplayOffsetX: z.number().min(-500).max(500).describe('Gameplay Horizontal Shift (px)').default(0),
  captionBottomOffset: z
    .number()
    .min(100)
    .max(800)
    .describe('Subtitles Distance From Bottom (px)')
    .default(380),
  highlightColor: zColor().describe('Base / Fallback Active Word Color').default('#00F0FF'),
  characterColors: z
    .array(zColor())
    .describe('Multi-Character Word-Sync Palette')
    .default(DEFAULT_CHARACTER_COLORS),
  characterNames: z
    .array(z.string())
    .describe('Character Speaker Labels')
    .default(['JASON', 'LUCIA', 'OFFICER', 'NPC', 'CALLER']),
  showCharacterTag: z.boolean().describe('Show Character Tag Badge Above Captions').default(false),
  zoomIntensity: z.number().min(0).max(3).describe('Audio Shake & Ken Burns Zoom Multiplier').default(1.0),
  subtitlesText: zTextarea().default(''),
  captions: z.array(z.custom<CaptionItem>()).default([]),
});

export type GtaShortProps = z.infer<typeof GtaShortSchema>;

export const GtaShort: React.FC<GtaShortProps> = ({
  clipFolder,
  hookText,
  showHook,
  showSubtitles = true,
  hasFacecam,
  facecamBox,
  facecamSplitPercent,
  facecamOffsetY = 0,
  facecamZoom = 1.0,
  gameplayOffsetX,
  captionBottomOffset,
  highlightColor,
  characterColors = DEFAULT_CHARACTER_COLORS,
  characterNames = ['JASON', 'LUCIA', 'OFFICER', 'NPC', 'CALLER'],
  showCharacterTag = false,
  zoomIntensity,
  subtitlesText = '',
  captions = [],
}) => {
  const frame = useCurrentFrame();
  const { fps, width: compositionWidth, height: compositionHeight } = useVideoConfig();

  const videoSrc = staticFile(`clips/${clipFolder}/clip.mp4`);

  // Audio visualization for camera impact shakes
  const audioData = useAudioData(videoSrc);

  // Audio amplitude & impact detection
  let audioIntensity = 0;
  if (audioData) {
    try {
      const samples = visualizeAudio({
        audioData,
        frame,
        fps,
        numberOfSamples: 16,
      });
      const avg = samples.reduce((acc, s) => acc + Math.abs(s), 0) / (samples.length || 1);
      audioIntensity = Math.min(1.0, avg * 3.5);
    } catch {
      audioIntensity = 0;
    }
  }

  // 1. Gentle continuous Ken Burns drift (alternates every 7s = 420 frames at 60fps)
  const driftPeriod = 60 * 7;
  const driftProgress = (frame % driftPeriod) / driftPeriod;
  const kenBurns = 1.0 + Math.sin(driftProgress * Math.PI * 2) * 0.03 * zoomIntensity;

  // 2. Audio impact punch-in & camera shake
  const impactPunch = audioIntensity > 0.35 ? (audioIntensity - 0.35) * 0.15 * zoomIntensity : 0;
  const shakeX = audioIntensity > 0.4 ? Math.sin(frame * 3.7) * 4 * zoomIntensity : 0;
  const shakeY = audioIntensity > 0.4 ? Math.cos(frame * 4.2) * 4 * zoomIntensity : 0;
  const totalScale = kenBurns + impactPunch;

  // Strict check: Only activate facecam split mode if hasFacecam is true AND box has real dimensions
  const isFacecamMode = Boolean(
    hasFacecam &&
      facecamBox &&
      (facecamBox.width ?? 0) >= 200 &&
      (facecamBox.height ?? 0) >= 120
  );

  // 3. Layout Heights
  const topHeight = Math.round(compositionHeight * (facecamSplitPercent / 100));
  const bottomHeight = compositionHeight - topHeight;

  // 4. Facecam zoom/crop calculations (only used in Facecam Mode)
  const safeBoxWidth = Math.max(100, facecamBox?.width || 480);
  const safeBoxHeight = Math.max(80, facecamBox?.height || 270);
  const scaleX = compositionWidth / safeBoxWidth;
  const scaleY = topHeight / safeBoxHeight;
  const facecamScale = Math.max(scaleX, scaleY) * (facecamZoom ?? 1.0);

  const facecamCenterX = (facecamBox?.x || 0) + safeBoxWidth / 2;
  // Natural framing: place vertical center at 45% of box height for comfortable headroom
  const facecamCenterY = (facecamBox?.y || 0) + safeBoxHeight * 0.45;

  const facecamTranslateX = compositionWidth / 2 - facecamCenterX * facecamScale;
  const facecamTranslateY = topHeight / 2 - facecamCenterY * facecamScale + (facecamOffsetY ?? 0);

  // 5. Active captions with live word-level editing from subtitlesText
  const activeCaptions = useMemo(() => {
    if (!subtitlesText || subtitlesText.trim() === '') {
      return captions;
    }

    // Split edited subtitlesText by whitespace words
    const editedWords = subtitlesText.trim().split(/\s+/).filter(Boolean);
    if (editedWords.length === 0) return captions;

    let wordIdx = 0;
    return captions.map((cap) => {
      const isPunctOnly = /^[.,?!]+$/.test(cap.text.trim());
      if (isPunctOnly) {
        return cap;
      }
      if (wordIdx < editedWords.length) {
        const newWord = editedWords[wordIdx++];
        const prefix = cap.text.startsWith(' ') ? ' ' : '';
        return {
          ...cap,
          text: prefix + newWord,
        };
      }
      return cap;
    });
  }, [captions, subtitlesText]);

  // 6. TikTok Style Captions
  const { pages } = useMemo(() => {
    if (!activeCaptions || activeCaptions.length === 0) {
      return { pages: [] };
    }
    return createTikTokStyleCaptions({
      captions: activeCaptions,
      combineTokensWithinMilliseconds: 900,
    });
  }, [activeCaptions]);

  const currentMs = (frame / fps) * 1000;
  const activePage = pages.find(
    (p) => currentMs >= p.startMs && currentMs < p.startMs + p.durationMs
  );

  // Helper to determine speakerId for a token
  const getSpeakerIdForToken = useMemo(() => {
    return (tokenFromMs: number): number => {
      // 1. Try matching with original enriched captions
      const match = activeCaptions.find(
        (c: CaptionItem) =>
          c.startMs === tokenFromMs ||
          Math.abs((c.startMs ?? c.fromMs ?? 0) - tokenFromMs) < 30
      );
      if (match && typeof match.speakerId === 'number') {
        return match.speakerId;
      }

      // 2. Fallback: compute turn count based on sentence punctuation & pauses
      let turns = 0;
      for (let i = 1; i < activeCaptions.length; i++) {
        const prev = activeCaptions[i - 1];
        const curr = activeCaptions[i];
        const currStart = curr.startMs ?? curr.fromMs ?? 0;
        if (currStart > tokenFromMs) break;
        const prevText = (prev.text || '').trim();
        const prevStart = prev.startMs ?? prev.fromMs ?? 0;
        const isSentenceEnd =
          prevText.endsWith('.') ||
          prevText.endsWith('?') ||
          prevText.endsWith('!') ||
          prevText === '.' ||
          prevText === '?' ||
          prevText === '!';
        const isLongPause = currStart - prevStart >= 1200;

        if (isSentenceEnd || isLongPause) {
          turns++;
        }
      }
      return turns;
    };
  }, [activeCaptions]);

  // Current active speaker ID for UI tags
  const currentActiveSpeakerId = useMemo(() => {
    if (!activePage) return 0;
    const activeToken = activePage.tokens.find(
      (t) => currentMs >= t.fromMs && currentMs <= t.toMs
    );
    if (activeToken) {
      return getSpeakerIdForToken(activeToken.fromMs);
    }
    return getSpeakerIdForToken(activePage.startMs);
  }, [activePage, currentMs, getSpeakerIdForToken]);

  const currentSpeakerColor =
    characterColors[currentActiveSpeakerId % (characterColors.length || 1)] || highlightColor;

  // 7. Top Hook Banner animation (first 3.5 seconds = 210 frames)
  const hookSpring = spring({
    frame,
    fps,
    config: {
      damping: 12,
      mass: 0.5,
      stiffness: 130,
    },
  });
  const hookFadeOut = interpolate(frame, [180, 210], [1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const hookOpacity = hookSpring * hookFadeOut;
  const hookScale = interpolate(hookSpring, [0, 1], [0.8, 1]);

  return (
    <AbsoluteFill style={{ backgroundColor: '#000000', fontFamily, overflow: 'hidden' }}>
      {isFacecamMode ? (
        // LAYOUT MODE 1: Streamer Facecam Split (Top: Facecam, Bottom: Gameplay)
        <>
          {/* Top Section: Cropped Facecam */}
          <div
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: compositionWidth,
              height: topHeight,
              overflow: 'hidden',
              backgroundColor: '#0a0a0f',
            }}
          >
            <div
              style={{
                width: 1920,
                height: 1080,
                transformOrigin: '0 0',
                transform: `translate(${facecamTranslateX}px, ${facecamTranslateY}px) scale(${facecamScale})`,
              }}
            >
              <OffthreadVideo
                src={videoSrc}
                style={{
                  width: 1920,
                  height: 1080,
                }}
              />
            </div>

            {/* Subtle Vignette on facecam */}
            <div
              style={{
                position: 'absolute',
                inset: 0,
                pointerEvents: 'none',
                boxShadow: 'inset 0 0 40px rgba(0,0,0,0.6)',
              }}
            />

            {/* Accent divider bar along the bottom edge */}
            <div
              style={{
                position: 'absolute',
                bottom: 0,
                left: 0,
                right: 0,
                height: 4,
                background: `linear-gradient(90deg, ${currentSpeakerColor}, #FF0055, ${currentSpeakerColor})`,
                boxShadow: `0 0 16px ${currentSpeakerColor}`,
                zIndex: 10,
              }}
            />
          </div>

          {/* Bottom Section: Center-Cropped 16:9 GTA Gameplay */}
          <div
            style={{
              position: 'absolute',
              top: topHeight,
              left: 0,
              width: compositionWidth,
              height: bottomHeight,
              overflow: 'hidden',
              backgroundColor: '#000',
            }}
          >
            <div
              style={{
                width: '100%',
                height: '100%',
                transform: `scale(${totalScale}) translate(${gameplayOffsetX + shakeX}px, ${shakeY}px)`,
                transformOrigin: 'center center',
              }}
            >
              <OffthreadVideo
                src={videoSrc}
                style={{
                  width: '100%',
                  height: '100%',
                  objectFit: 'cover',
                }}
              />
            </div>
          </div>
        </>
      ) : (
        // LAYOUT MODE 2: Pure Gameplay Full-Screen (1080x1920 center-cropped, NO top section)
        <AbsoluteFill style={{ overflow: 'hidden' }}>
          <div
            style={{
              width: '100%',
              height: '100%',
              transform: `scale(${totalScale}) translate(${gameplayOffsetX + shakeX}px, ${shakeY}px)`,
              transformOrigin: 'center center',
            }}
          >
            <OffthreadVideo
              src={videoSrc}
              style={{
                width: '100%',
                height: '100%',
                objectFit: 'cover',
              }}
            />
          </div>

          {/* Cinematic subtle edge vignette */}
          <AbsoluteFill
            style={{
              pointerEvents: 'none',
              background:
                'radial-gradient(circle at center, transparent 65%, rgba(0, 0, 0, 0.6) 100%)',
            }}
          />
        </AbsoluteFill>
      )}

      {/* TOP HOOK BANNER (First 3.5s) */}
      {showHook && frame < 210 && hookText ? (
        <div
          style={{
            position: 'absolute',
            top: isFacecamMode ? `${facecamSplitPercent + 2}%` : '12%',
            left: 40,
            right: 40,
            zIndex: 60,
            display: 'flex',
            justifyContent: 'center',
            opacity: hookOpacity,
            transform: `scale(${hookScale})`,
            pointerEvents: 'none',
          }}
        >
          <div
            style={{
              backgroundColor: 'rgba(10, 12, 20, 0.9)',
              border: '3px solid #FFE600',
              borderRadius: 16,
              padding: '12px 28px',
              color: '#FFE600',
              fontSize: 34,
              fontWeight: 900,
              textTransform: 'uppercase',
              textAlign: 'center',
              boxShadow: '0 8px 30px rgba(0,0,0,0.85), 0 0 20px rgba(255, 230, 0, 0.4)',
              letterSpacing: '1.5px',
            }}
          >
            {hookText}
          </div>
        </div>
      ) : null}

      {/* WORD-BY-WORD ANIMATED CAPTIONS (WITH CHARACTER-BASED SYNC HIGHLIGHT) */}
      {showSubtitles && activePage && (
        <Interactive.Div
          name="Captions Container"
          style={{
            position: 'absolute',
            left: 48,
            right: 48,
            bottom: captionBottomOffset,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            zIndex: 50,
            pointerEvents: 'none',
            translate: '0px 89.4px'
          }}
        >
          {/* Optional subtle character tag indicator */}
          {showCharacterTag && (
            <div
              style={{
                fontSize: 20,
                fontWeight: 900,
                color: currentSpeakerColor,
                letterSpacing: '2px',
                marginBottom: 12,
                textShadow: '0 2px 8px rgba(0,0,0,0.9)',
                backgroundColor: 'rgba(10, 10, 15, 0.75)',
                padding: '4px 16px',
                borderRadius: 12,
                border: `1.5px solid ${currentSpeakerColor}`,
                textTransform: 'uppercase',
              }}
            >
              {characterNames[currentActiveSpeakerId % characterNames.length] ||
                `CHARACTER ${currentActiveSpeakerId + 1}`}
            </div>
          )}

          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              justifyContent: 'center',
              alignItems: 'center',
              gap: '14px 18px',
            }}
          >
            {activePage.tokens.map((token, idx) => {
              const isActive = currentMs >= token.fromMs && currentMs <= token.toMs;
              const tokenSpeakerId = getSpeakerIdForToken(token.fromMs);
              const tokenColor =
                characterColors[tokenSpeakerId % (characterColors.length || 1)] || highlightColor;

              return (
                <span
                  key={`${token.text}-${idx}`}
                  style={{
                    fontFamily,
                    fontWeight: 900,
                    fontSize: 54,
                    textTransform: 'uppercase',
                    color: isActive ? tokenColor : '#FFFFFF',
                    transform: isActive ? 'scale(1.15)' : 'scale(1.0)',
                    WebkitTextStroke: '10px #000000',
                    paintOrder: 'stroke fill',
                    textShadow: isActive
                      ? `0 0 24px ${tokenColor}, 0 6px 14px rgba(0,0,0,0.9)`
                      : '0 6px 14px rgba(0,0,0,0.9)',
                    lineHeight: 1.2,
                  }}
                >
                  {token.text}
                </span>
              );
            })}
          </div>
        </Interactive.Div>
      )}
    </AbsoluteFill>
  );
};
