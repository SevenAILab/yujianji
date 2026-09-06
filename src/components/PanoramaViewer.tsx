"use client";

import { ArrowLeft, ArrowUpRight, Minus, Rotate3D } from "lucide-react";
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { usePageZoomLock } from "@/lib/use-page-zoom-lock";
import { panoramaZoom } from "@/lib/viewer-gestures";
import styles from "./PanoramaViewer.module.css";

type PanoramaViewerProps = {
  photo: string;
  name: string;
  onExit: () => void;
  onOpenDetail: () => void;
};

type ViewMode = "immersive" | "sphere";



const vertexShaderSource = `
  attribute vec2 a_position;
  varying vec2 v_position;
  void main() {
    v_position = a_position;
    gl_Position = vec4(a_position, 0.0, 1.0);
  }
`;

const fragmentShaderSource = `
  precision highp float;
  varying vec2 v_position;
  uniform sampler2D u_texture;
  uniform vec2 u_resolution;
  uniform float u_yaw;
  uniform float u_pitch;
  uniform float u_mode;
  uniform float u_sphere_scale;
  uniform float u_zoom;
  uniform float u_ready;

  const float PI = 3.141592653589793;

  vec3 rotate_view(vec3 direction) {
    float cp = cos(u_pitch);
    float sp = sin(u_pitch);
    direction = vec3(
      direction.x,
      cp * direction.y - sp * direction.z,
      sp * direction.y + cp * direction.z
    );
    float cy = cos(u_yaw);
    float sy = sin(u_yaw);
    return vec3(
      cy * direction.x + sy * direction.z,
      direction.y,
      -sy * direction.x + cy * direction.z
    );
  }

  vec2 panorama_uv(vec3 direction) {
    direction = normalize(direction);
    float longitude = atan(direction.x, direction.z);
    float latitude = asin(clamp(direction.y, -1.0, 1.0));
    return vec2(fract(0.5 + longitude / (2.0 * PI)), 0.5 - latitude / PI);
  }

  void main() {
    if (u_ready < 0.5) {
      gl_FragColor = vec4(0.969, 0.961, 0.925, 1.0);
      return;
    }

    float aspect = u_resolution.x / max(u_resolution.y, 1.0);
    vec2 point = vec2(v_position.x * aspect, v_position.y);

    if (u_mode < 0.5) {
      float tangent = tan(0.62) / max(u_zoom, 1.0);
      vec3 ray = normalize(vec3(point.x * tangent, point.y * tangent, 1.0));
      vec3 direction = rotate_view(ray);
      gl_FragColor = texture2D(u_texture, panorama_uv(direction));
      return;
    }

    float sphere_radius = u_sphere_scale * min(aspect, 1.0);
    float distance_to_center = length(point);
    if (distance_to_center > sphere_radius) {
      gl_FragColor = vec4(0.969, 0.961, 0.925, 1.0);
      return;
    }

    vec2 sphere_point = point / sphere_radius;
    float sphere_z = sqrt(max(0.0, 1.0 - dot(sphere_point, sphere_point)));
    vec3 normal = normalize(vec3(sphere_point.x, sphere_point.y, sphere_z));
    vec3 direction = rotate_view(normal);
    vec4 color = texture2D(u_texture, panorama_uv(direction));
    float edge = smoothstep(0.02, 0.18, sphere_z);
    float light = 0.68 + 0.32 * max(0.0, dot(normal, normalize(vec3(-0.35, 0.55, 1.0))));
    color.rgb *= light;
    color.rgb += pow(max(0.0, dot(normal, normalize(vec3(-0.5, 0.65, 1.0)))), 18.0) * 0.14;
    color.rgb = mix(vec3(0.969, 0.961, 0.925), color.rgb, edge);
    gl_FragColor = vec4(color.rgb, 1.0);
  }
`;

function createShader(gl: WebGLRenderingContext, type: number, source: string) {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("无法创建全景着色器");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader) || "全景着色器编译失败";
    gl.deleteShader(shader);
    throw new Error(message);
  }
  return shader;
}

export function PanoramaViewer({ photo, name, onExit, onOpenDetail }: PanoramaViewerProps) {
  usePageZoomLock();
  const viewerRef = useRef<HTMLDivElement>(null);
  const zoomRef = useRef(1);
  const exitRef = useRef(onExit);
  exitRef.current = onExit;
  const exitedRef = useRef(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const modeRef = useRef<ViewMode>("immersive");
  const sphereScaleRef = useRef(0.94);
  const yawRef = useRef(0);
  const pitchRef = useRef(0);
  const pointersRef = useRef(new Map<number, { x: number; y: number }>());
  const dragStartRef = useRef<{ x: number; y: number; yaw: number; pitch: number } | null>(null);
  const pinchStartRef = useRef<{ distance: number; scale: number } | null>(null);

  const [mode, setMode] = useState<ViewMode>("immersive");
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");

  function applyZoom(value: number) {
    const next = panoramaZoom(value);
    zoomRef.current = next.zoom;
    sphereScaleRef.current = next.zoom * 0.94;
    const nextMode = next.zoom < 1 ? "sphere" : "immersive";
    modeRef.current = nextMode;
    setMode(nextMode);
    if (next.exit && !exitedRef.current) {
      exitedRef.current = true;
      exitRef.current();
    }
  }

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    const overflow = document.body.style.overflow;
    const rootOverflow = document.documentElement.style.overflow;
    document.body.style.overflow = "hidden";
    document.documentElement.style.overflow = "hidden";
    let wheelZoom = zoomRef.current;
    let lastWheel = 0;
    function wheel(event: WheelEvent) {
      event.preventDefault();
      if (performance.now() - lastWheel > 250) wheelZoom = zoomRef.current;
      lastWheel = performance.now();
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? window.innerHeight : 1);
      wheelZoom = Math.min(3, wheelZoom * Math.exp(-Math.max(-120, Math.min(120, delta)) * 0.005));
      applyZoom(wheelZoom);
    }
    viewer.addEventListener("wheel", wheel, { passive: false });
    return () => {
      viewer.removeEventListener("wheel", wheel);
      document.body.style.overflow = overflow;
      document.documentElement.style.overflow = rootOverflow;
    };
  }, []);

  function pointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    event.currentTarget.setPointerCapture(event.pointerId);
    if (pointersRef.current.size === 1) {
      dragStartRef.current = {
        x: event.clientX,
        y: event.clientY,
        yaw: yawRef.current,
        pitch: pitchRef.current,
      };
    } else if (pointersRef.current.size === 2) {
      const [first, second] = [...pointersRef.current.values()];
      if (first && second) {
        pinchStartRef.current = {
          distance: Math.hypot(second.x - first.x, second.y - first.y),
          scale: zoomRef.current,
        };
      }
      dragStartRef.current = null;
    }
  }

  function pointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    if (!pointersRef.current.has(event.pointerId)) return;
    pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointersRef.current.size >= 2) {
      const [first, second] = [...pointersRef.current.values()];
      const pinch = pinchStartRef.current;
      if (!first || !second || !pinch?.distance) return;
      const distance = Math.hypot(second.x - first.x, second.y - first.y);
      const ratio = distance / pinch.distance;
      applyZoom(pinch.scale * ratio);
      return;
    }

    const drag = dragStartRef.current;
    if (!drag) return;
    yawRef.current = drag.yaw - (event.clientX - drag.x) * 0.0045 / Math.max(1, zoomRef.current);
    pitchRef.current = Math.max(-1.15, Math.min(1.15, drag.pitch + (event.clientY - drag.y) * 0.0035 / Math.max(1, zoomRef.current)));
  }

  function pointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    pointersRef.current.delete(event.pointerId);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (pointersRef.current.size < 2) pinchStartRef.current = null;
    const remaining = [...pointersRef.current.values()][0];
    dragStartRef.current = remaining ? { ...remaining, yaw: yawRef.current, pitch: pitchRef.current } : null;
  }

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const gl = canvas.getContext("webgl", { alpha: false, antialias: true });
    if (!gl) {
      setError("当前浏览器没有开启全景图形能力");
      return;
    }

    let frame = 0;
    let disposed = false;
    let imageReady = false;
    try {
      const vertex = createShader(gl, gl.VERTEX_SHADER, vertexShaderSource);
      const fragment = createShader(gl, gl.FRAGMENT_SHADER, fragmentShaderSource);
      const program = gl.createProgram();
      if (!program) throw new Error("无法创建全景程序");
      gl.attachShader(program, vertex);
      gl.attachShader(program, fragment);
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        throw new Error(gl.getProgramInfoLog(program) || "全景程序连接失败");
      }
      gl.useProgram(program);

      const buffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
      const position = gl.getAttribLocation(program, "a_position");
      gl.enableVertexAttribArray(position);
      gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);

      const texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([247, 245, 237, 255]));

      const image = new Image();
      image.decoding = "async";
      image.onload = () => {
        if (disposed) return;
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
        imageReady = true;
        setReady(true);
      };
      image.onerror = () => {
        if (!disposed) setError("全景照片加载失败，请返回地球后重试");
      };
      image.src = photo;

      const resolution = gl.getUniformLocation(program, "u_resolution");
      const yaw = gl.getUniformLocation(program, "u_yaw");
      const pitch = gl.getUniformLocation(program, "u_pitch");
      const viewMode = gl.getUniformLocation(program, "u_mode");
      const sphereScale = gl.getUniformLocation(program, "u_sphere_scale");
      const viewZoom = gl.getUniformLocation(program, "u_zoom");
      const textureReady = gl.getUniformLocation(program, "u_ready");

      function render() {
        if (disposed) return;
        // canvas / gl 在 effect 顶部已判空返回；这里再守一次，
        // 因为 TS 不把外层 narrowing 带进这个 hoisted function declaration。
        if (!canvas || !gl) return;
        const bounds = canvas.getBoundingClientRect();
        const ratio = Math.min(window.devicePixelRatio || 1, 2);
        const width = Math.max(1, Math.round(bounds.width * ratio));
        const height = Math.max(1, Math.round(bounds.height * ratio));
        if (canvas.width !== width || canvas.height !== height) {
          canvas.width = width;
          canvas.height = height;
        }
        gl.viewport(0, 0, width, height);
        gl.uniform2f(resolution, width, height);
        gl.uniform1f(yaw, yawRef.current);
        gl.uniform1f(pitch, pitchRef.current);
        gl.uniform1f(viewMode, modeRef.current === "immersive" ? 0 : 1);
        gl.uniform1f(sphereScale, sphereScaleRef.current);
        gl.uniform1f(viewZoom, zoomRef.current);
        gl.uniform1f(textureReady, imageReady ? 1 : 0);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
        frame = requestAnimationFrame(render);
      }
      frame = requestAnimationFrame(render);

      return () => {
        disposed = true;
        cancelAnimationFrame(frame);
        gl.deleteTexture(texture);
        gl.deleteBuffer(buffer);
        gl.deleteProgram(program);
        gl.deleteShader(vertex);
        gl.deleteShader(fragment);
      };
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "全景视图初始化失败");
    }
  }, [photo]);

  return (
    <div
      ref={viewerRef}
      className={styles.viewer}
      onPointerDown={pointerDown}
      onPointerMove={pointerMove}
      onPointerUp={pointerUp}
      onPointerCancel={pointerUp}
    >
      <canvas ref={canvasRef} aria-label={`${name}的360度全景照片`} />
      <div className={styles.topbar}>
        <button type="button" onPointerDown={(event) => event.stopPropagation()} onClick={onExit}>
          <ArrowLeft size={17} /> 返回地球
        </button>
        <span>{name} · 360°</span>
        <button type="button" onPointerDown={(event) => event.stopPropagation()} onClick={onOpenDetail}>
          记录 <ArrowUpRight size={15} />
        </button>
      </div>
      {!ready && !error ? <div className={styles.loading}>正在展开全景…</div> : null}
      {error ? <div className={styles.error}>{error}</div> : null}
      <div className={styles.guide}>
        {mode === "immersive" ? (
          <><Rotate3D size={15} /> 拖动环顾 · 双指缩放照片</>
        ) : (
          <><Minus size={15} /> 继续缩小照片球 · 缩到最小返回地球</>
        )}
      </div>
    </div>
  );
}
