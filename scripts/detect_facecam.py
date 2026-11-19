import sys
import os
import json
import argparse
import cv2
import numpy as np

def detect_facecam(video_path: str):
    """
    Detects if a streamer facecam overlay exists in one of the 4 corners of the video clip.
    Uses deep-learning YuNet face detector with spatial clustering and edge-snapping,
    with fallback to multi-scale Haar cascades.
    
    Returns:
      {
        "hasFacecam": bool,
        "corner": "top-left" | "top-right" | "bottom-left" | "bottom-right" | "none",
        "facecamBox": {"x": int, "y": int, "width": int, "height": int}
      }
    """
    if not os.path.exists(video_path):
        return {
            "hasFacecam": False,
            "corner": "none",
            "facecamBox": {"x": 0, "y": 0, "width": 0, "height": 0}
        }

    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        return {
            "hasFacecam": False,
            "corner": "none",
            "facecamBox": {"x": 0, "y": 0, "width": 0, "height": 0}
        }

    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))

    if total_frames <= 0 or width <= 0 or height <= 0:
        cap.release()
        return {
            "hasFacecam": False,
            "corner": "none",
            "facecamBox": {"x": 0, "y": 0, "width": 0, "height": 0}
        }

    script_dir = os.path.dirname(os.path.abspath(__file__))
    onnx_path = os.path.join(script_dir, "face_detection_yunet_2023mar.onnx")

    detector = None
    if os.path.exists(onnx_path) and hasattr(cv2, "FaceDetectorYN"):
        try:
            detector = cv2.FaceDetectorYN.create(
                model=onnx_path,
                config="",
                input_size=(width, height),
                score_threshold=0.5,
                nms_threshold=0.3
            )
        except Exception:
            detector = None

    # Haar cascade fallback
    cascades = []
    if detector is None:
        for casc_name in ["haarcascade_frontalface_alt2.xml", "haarcascade_profileface.xml", "haarcascade_frontalface_default.xml"]:
            cpath = os.path.join(cv2.data.haarcascades, casc_name)
            if os.path.exists(cpath):
                casc = cv2.CascadeClassifier(cpath)
                if not casc.empty():
                    cascades.append(casc)

    # Sample 12 evenly-spaced frames across duration
    sample_indices = [int(total_frames * (i / 13.0)) for i in range(1, 13)]
    frames = []
    corner_faces = {
        "top-left": [],
        "top-right": [],
        "bottom-left": [],
        "bottom-right": []
    }

    for idx in sample_indices:
        cap.set(cv2.CAP_PROP_POS_FRAMES, idx)
        ret, frame = cap.read()
        if not ret or frame is None:
            continue
        frames.append(frame)

        if detector:
            detector.setInputSize((width, height))
            _, faces = detector.detect(frame)
            if faces is not None:
                for face in faces:
                    bx, by, bw, bh = face[0:4].astype(int)
                    cx, cy = bx + bw / 2.0, by + bh / 2.0
                    # Ignore gameplay faces in center screen
                    if cx < width * 0.38 and cy < height * 0.42:
                        corner_faces["top-left"].append([bx, by, bw, bh])
                    elif cx > width * 0.62 and cy < height * 0.42:
                        corner_faces["top-right"].append([bx, by, bw, bh])
                    elif cx < width * 0.38 and cy > height * 0.58:
                        corner_faces["bottom-left"].append([bx, by, bw, bh])
                    elif cx > width * 0.62 and cy > height * 0.58:
                        corner_faces["bottom-right"].append([bx, by, bw, bh])
        elif cascades:
            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            corner_rois = {
                "top-left": (0, 0, int(width * 0.38), int(height * 0.42)),
                "top-right": (int(width * 0.62), 0, width, int(height * 0.42)),
                "bottom-left": (0, int(height * 0.58), int(width * 0.38), height),
                "bottom-right": (int(width * 0.62), int(height * 0.58), width, height),
            }
            for c_name, (rx1, ry1, rx2, ry2) in corner_rois.items():
                roi = gray[ry1:ry2, rx1:rx2]
                for casc in cascades:
                    det = casc.detectMultiScale(roi, scaleFactor=1.06, minNeighbors=3, minSize=(50, 50))
                    for (fx, fy, fw, fh) in det:
                        corner_faces[c_name].append([rx1 + fx, ry1 + fy, fw, fh])

    cap.release()

    # Find corner with largest spatial cluster of face centers
    best_corner = None
    best_cluster = None
    max_cluster_size = 0

    for c_name, flist in corner_faces.items():
        if len(flist) < 4:
            continue
        centers = np.array([[b[0] + b[2] / 2.0, b[1] + b[3] / 2.0] for b in flist])
        for c in centers:
            dists = np.linalg.norm(centers - c, axis=1)
            cl = [flist[j] for j in range(len(flist)) if dists[j] < 90]
            if len(cl) > max_cluster_size:
                max_cluster_size = len(cl)
                best_cluster = cl
                best_corner = c_name

    # Require at least 4 consistent detections in the cluster (out of 12 sampled frames)
    if not best_corner or max_cluster_size < 4:
        return {
            "hasFacecam": False,
            "corner": "none",
            "facecamBox": {"x": 0, "y": 0, "width": 0, "height": 0}
        }

    med = np.median(best_cluster, axis=0)
    fx, fy, fw, fh = int(med[0]), int(med[1]), int(med[2]), int(med[3])

    box_x, box_y, box_w, box_h = 0, 0, 0, 0

    if best_corner == "bottom-left":
        edge_x_cands = []
        edge_y_cands = []
        for frm in frames:
            y_check = min(height - 10, max(0, fy + fh // 2))
            x_start = min(width - 1, fx + fw)
            x_end = min(width - 1, int(width * 0.48))
            if x_end > x_start:
                diff_x = np.abs(np.diff(frm[y_check, x_start:x_end, :].astype(float), axis=0)).sum(axis=-1)
                edge_x_cands.append(x_start + np.argmax(diff_x) + 1)
            x_check = min(width - 1, max(0, fx + fw // 2))
            y_start = int(height * 0.52)
            y_end = fy
            if y_end > y_start:
                diff_y = np.abs(np.diff(frm[y_start:y_end, x_check, :].astype(float), axis=0)).sum(axis=-1)
                edge_y_cands.append(y_start + np.argmax(diff_y) + 1)

        right_edge = int(np.median(edge_x_cands)) if (edge_x_cands and np.std(edge_x_cands) < 30) else min(width, int(fx + fw * 1.8))
        top_edge = int(np.median(edge_y_cands)) if (edge_y_cands and np.std(edge_y_cands) < 30) else max(0, int(fy - fh * 0.6))

        box_x = 0
        box_y = max(0, top_edge)
        box_w = max(280, right_edge)
        box_h = max(200, height - box_y)

    elif best_corner == "top-left":
        edge_x_cands = []
        edge_y_cands = []
        for frm in frames:
            y_check = min(height - 10, max(0, fy + fh // 2))
            x_start = min(width - 1, fx + fw)
            x_end = min(width - 1, int(width * 0.48))
            if x_end > x_start:
                diff_x = np.abs(np.diff(frm[y_check, x_start:x_end, :].astype(float), axis=0)).sum(axis=-1)
                edge_x_cands.append(x_start + np.argmax(diff_x) + 1)
            x_check = min(width - 1, max(0, fx + fw // 2))
            y_start = min(height - 1, fy + fh)
            y_end = min(height - 1, int(height * 0.50))
            if y_end > y_start:
                diff_y = np.abs(np.diff(frm[y_start:y_end, x_check, :].astype(float), axis=0)).sum(axis=-1)
                edge_y_cands.append(y_start + np.argmax(diff_y) + 1)

        right_edge = int(np.median(edge_x_cands)) if (edge_x_cands and np.std(edge_x_cands) < 30) else min(width, int(fx + fw * 1.8))
        bottom_edge = int(np.median(edge_y_cands)) if (edge_y_cands and np.std(edge_y_cands) < 30) else min(height, int(fy + fh * 1.6))

        box_x = 0
        box_y = 0
        box_w = max(280, right_edge)
        box_h = max(200, bottom_edge)

    elif best_corner == "bottom-right":
        edge_x_cands = []
        edge_y_cands = []
        for frm in frames:
            y_check = min(height - 10, max(0, fy + fh // 2))
            x_start = int(width * 0.52)
            x_end = max(0, fx)
            if x_end > x_start:
                diff_x = np.abs(np.diff(frm[y_check, x_start:x_end, :].astype(float), axis=0)).sum(axis=-1)
                edge_x_cands.append(x_start + np.argmax(diff_x) + 1)
            x_check = min(width - 1, max(0, fx + fw // 2))
            y_start = int(height * 0.52)
            y_end = fy
            if y_end > y_start:
                diff_y = np.abs(np.diff(frm[y_start:y_end, x_check, :].astype(float), axis=0)).sum(axis=-1)
                edge_y_cands.append(y_start + np.argmax(diff_y) + 1)

        left_edge = int(np.median(edge_x_cands)) if (edge_x_cands and np.std(edge_x_cands) < 30) else max(0, int(fx - fw * 0.8))
        top_edge = int(np.median(edge_y_cands)) if (edge_y_cands and np.std(edge_y_cands) < 30) else max(0, int(fy - fh * 0.6))

        box_x = max(0, left_edge)
        box_y = max(0, top_edge)
        box_w = max(280, width - box_x)
        box_h = max(200, height - box_y)

    elif best_corner == "top-right":
        edge_x_cands = []
        edge_y_cands = []
        for frm in frames:
            y_check = min(height - 10, max(0, fy + fh // 2))
            x_start = int(width * 0.52)
            x_end = max(0, fx)
            if x_end > x_start:
                diff_x = np.abs(np.diff(frm[y_check, x_start:x_end, :].astype(float), axis=0)).sum(axis=-1)
                edge_x_cands.append(x_start + np.argmax(diff_x) + 1)
            x_check = min(width - 1, max(0, fx + fw // 2))
            y_start = min(height - 1, fy + fh)
            y_end = min(height - 1, int(height * 0.50))
            if y_end > y_start:
                diff_y = np.abs(np.diff(frm[y_start:y_end, x_check, :].astype(float), axis=0)).sum(axis=-1)
                edge_y_cands.append(y_start + np.argmax(diff_y) + 1)

        left_edge = int(np.median(edge_x_cands)) if (edge_x_cands and np.std(edge_x_cands) < 30) else max(0, int(fx - fw * 0.8))
        bottom_edge = int(np.median(edge_y_cands)) if (edge_y_cands and np.std(edge_y_cands) < 30) else min(height, int(fy + fh * 1.6))

        box_x = max(0, left_edge)
        box_y = 0
        box_w = max(280, width - box_x)
        box_h = max(200, bottom_edge)

    return {
        "hasFacecam": True,
        "corner": best_corner,
        "facecamBox": {
            "x": int(box_x),
            "y": int(box_y),
            "width": int(box_w),
            "height": int(box_h)
        }
    }

def main():
    parser = argparse.ArgumentParser(description="Detect facecam overlay in video clip")
    parser.add_argument("video_path", help="Path to input video MP4")
    parser.add_argument("--output", help="Optional path to output or update meta.json")
    args = parser.parse_args()

    result = detect_facecam(args.video_path)

    if args.output:
        existing = {}
        if os.path.exists(args.output):
            try:
                with open(args.output, "r", encoding="utf-8") as f:
                    existing = json.load(f)
            except Exception:
                existing = {}
        existing.update(result)
        os.makedirs(os.path.dirname(os.path.abspath(args.output)), exist_ok=True)
        with open(args.output, "w", encoding="utf-8") as f:
            json.dump(existing, f, indent=2)

    print(json.dumps(result, indent=2))

if __name__ == "__main__":
    main()
