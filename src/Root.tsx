import React from 'react';
import { Composition, staticFile, CalculateMetadataFunction } from 'remotion';
import {
  GtaShort,
  GtaShortProps,
  GtaShortSchema,
  DEFAULT_CHARACTER_COLORS,
  CaptionItem,
} from './GtaShort';

type ClipMetadata = {
  duration?: number;
  hookText?: string;
  hasFacecam?: boolean;
  showSubtitles?: boolean;
  subtitlesText?: string;
  facecamBox?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
};

const createCalculateMetadata = (
  clipFolder: string
): CalculateMetadataFunction<GtaShortProps> => {
  return async ({ defaultProps, props: incomingProps }) => {
    let meta: ClipMetadata | null = null;
    let captions: CaptionItem[] = [];

    try {
      const metaUrl = staticFile(`clips/${clipFolder}/meta.json`);
      const res = await fetch(metaUrl);
      if (res.ok) {
        meta = await res.json();
      }
    } catch {
      // Ignored if file does not exist yet
    }

    try {
      const capUrl = staticFile(`clips/${clipFolder}/captions.json`);
      const res = await fetch(capUrl);
      if (res.ok) {
        captions = (await res.json()) as CaptionItem[];
      }
    } catch {
      // Ignored if file does not exist yet
    }

    // Check if user manually changed values in Remotion Studio
    const isUserEdited = (key: keyof GtaShortProps) => {
      return (
        incomingProps &&
        incomingProps[key] !== undefined &&
        incomingProps[key] !== defaultProps[key]
      );
    };

    const hookText = isUserEdited('hookText')
      ? (incomingProps.hookText as string)
      : meta?.hookText ?? defaultProps.hookText;

    const hasFacecam = isUserEdited('hasFacecam')
      ? (incomingProps.hasFacecam as boolean)
      : typeof meta?.hasFacecam === 'boolean'
        ? meta.hasFacecam
        : defaultProps.hasFacecam;

    const showSubtitles = isUserEdited('showSubtitles')
      ? (incomingProps.showSubtitles as boolean)
      : typeof meta?.showSubtitles === 'boolean'
        ? meta.showSubtitles
        : defaultProps.showSubtitles;

    const facecamBox = isUserEdited('facecamBox')
      ? incomingProps.facecamBox
      : meta?.facecamBox ?? defaultProps.facecamBox;

    let autoTranscript = meta?.subtitlesText || '';
    if (!autoTranscript && captions.length > 0) {
      const lines: string[] = [];
      let currentLine = '';
      for (const cap of captions) {
        currentLine += cap.text;
        if (/[.?!]/.test(cap.text)) {
          lines.push(currentLine.trim());
          currentLine = '';
        }
      }
      if (currentLine.trim()) {
        lines.push(currentLine.trim());
      }
      autoTranscript = lines.join('\n');
    }

    const subtitlesText = isUserEdited('subtitlesText')
      ? (incomingProps.subtitlesText as string)
      : autoTranscript || defaultProps.subtitlesText;

    const durationSeconds = typeof meta?.duration === 'number' ? meta.duration : 54;
    const durationInFrames = Math.max(60, Math.round(durationSeconds * 60));

    return {
      durationInFrames,
      props: {
        ...defaultProps,
        ...incomingProps,
        clipFolder,
        hookText,
        showSubtitles,
        hasFacecam,
        facecamBox,
        subtitlesText,
        captions:
          Array.isArray(incomingProps?.captions) && incomingProps.captions.length > 0
            ? incomingProps.captions
            : Array.isArray(captions) && captions.length > 0
              ? captions
              : defaultProps.captions,
      },
    };
  };
};

const defaultClipProps = (clipFolder: string): GtaShortProps => ({
  clipFolder,
  hookText: 'HE DID NOT SEE THIS COMING',
  showHook: true,
  showSubtitles: true,
  hasFacecam: false,
  facecamBox: {
    x: 1380,
    y: 60,
    width: 480,
    height: 270,
  },
  facecamSplitPercent: 32,
  facecamOffsetY: 0,
  facecamZoom: 1.0,
  gameplayOffsetX: 0,
  captionBottomOffset: 380,
  highlightColor: '#00F0FF',
  characterColors: DEFAULT_CHARACTER_COLORS,
  characterNames: ['JASON', 'LUCIA', 'OFFICER', 'NPC', 'CALLER'],
  showCharacterTag: false,
  zoomIntensity: 1.0,
  subtitlesText: '',
  captions: [],
});

export const RemotionRoot: React.FC = () => {
  const clipIndices = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

  return (
    <>
      {clipIndices.map((i) => (
        <Composition
          key={i}
          id={`Clip${i}`}
          component={GtaShort}
          durationInFrames={60 * 54}
          fps={60}
          width={1080}
          height={1920}
          schema={GtaShortSchema}
          defaultProps={defaultClipProps(`clip_${i}`)}
          calculateMetadata={createCalculateMetadata(`clip_${i}`)}
        />
      ))}
    </>
  );
};
