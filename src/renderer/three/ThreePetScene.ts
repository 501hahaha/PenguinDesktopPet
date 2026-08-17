import * as THREE from "three";
import type { PetState } from "../../pet/PetStateMachine";
import type { PetStyleAssetUrls } from "../../settings/types";
import type { WindowShapeRect } from "../types";

export interface PetVisualBounds {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface ThreePetSceneOptions {
  petStyleAssets?: PetStyleAssetUrls;
  petStyleIsCustom?: boolean;
  onTap?: () => void;
  onMoveWindowStart?: () => void;
  onMoveWindow?: () => void;
  onMoveWindowEnd?: () => void;
  onWindowShapeChange?: (rects: WindowShapeRect[]) => void;
  onPetVisualBoundsChange?: (bounds: PetVisualBounds) => void;
  onContextMenu?: () => void;
  onHoverChange?: (hovered: boolean) => void;
  onVideoWarning?: (message: string) => void;
}

interface SpriteFrame {
  row: number;
  y: number;
  duration: number;
}

const ALPHA_VIDEO_FILES: Record<PetState, string> = {
  idle: "IDLE.webm",
  walk: "WALK.webm",
  happy: "HAPPY.webm",
  shy: "SHY.webm",
  sleep: "SLEEP.webm",
  eat: "EAT.webm",
  angry: "ANGRY.webm",
};

const DEFAULT_PET_STYLE_ASSETS: PetStyleAssetUrls = {
  assets: {
    idle: "penguin-pet://default-penguin/IDLE.webm",
    walk: "penguin-pet://default-penguin/WALK.webm",
    happy: "penguin-pet://default-penguin/HAPPY.webm",
    shy: "penguin-pet://default-penguin/SHY.webm",
    sleep: "penguin-pet://default-penguin/SLEEP.webm",
    eat: "penguin-pet://default-penguin/EAT.webm",
    angry: "penguin-pet://default-penguin/ANGRY.webm",
  },
  cycleStates: [
    { id: "idle", name: "待机", description: "安静陪伴", fallbackState: "idle" },
    { id: "walk", name: "行走", description: "准备出发", fallbackState: "walk" },
    { id: "happy", name: "开心", description: "开心互动", fallbackState: "happy" },
    { id: "shy", name: "害羞", description: "害羞回应", fallbackState: "shy" },
    { id: "sleep", name: "睡觉", description: "安静休息", fallbackState: "sleep" },
    { id: "eat", name: "吃东西", description: "享受美食", fallbackState: "eat" },
    { id: "angry", name: "生气", description: "情绪表达", fallbackState: "angry" },
  ],
};

const SHAPE_MASK_SIZE = 192;
const SHAPE_ALPHA_THRESHOLD = 8;
const SHAPE_UPDATE_INTERVAL_MS = 400;
const RENDER_INTERVAL_MS = 1000 / 30;
const MAX_STABLE_SHAPE_RECTS = 1536;
const MIN_STABLE_SHAPE_COVERAGE = 0.08;
const VIDEO_PLANE_ASPECT = 1.62 / 1.377;
const VIDEO_PLANE_SCALE_X = 1 / VIDEO_PLANE_ASPECT;
const STATE_TRANSITION_DURATION_MS = 520;

/**
 * 2.5D scene built from the original penguin sprite sheet.
 *
 * The artwork remains the source of truth for the penguin's appearance and
 * actions. Three.js adds depth, lighting, shadow, floating and rotation around
 * the sprite card, so the character stays recognizable instead of becoming a
 * different procedural model.
 */
export class ThreePetScene {
  public readonly available: boolean;

  private readonly canvas: HTMLCanvasElement;
  private readonly onTap?: () => void;
  private readonly onMoveWindowStart?: () => void;
  private readonly onMoveWindow?: () => void;
  private readonly onMoveWindowEnd?: () => void;
  private readonly onWindowShapeChange?: (rects: WindowShapeRect[]) => void;
  private readonly onPetVisualBoundsChange?: (bounds: PetVisualBounds) => void;
  private readonly onContextMenu?: () => void;
  private readonly onHoverChange?: (hovered: boolean) => void;
  private readonly onVideoWarning?: (message: string) => void;
  private renderer: THREE.WebGLRenderer | undefined;
  private scene: THREE.Scene | undefined;
  private camera: THREE.PerspectiveCamera | undefined;
  private petRoot: THREE.Group | undefined;
  private spriteCard: THREE.Group | undefined;
  private spriteTexture: THREE.Texture | undefined;
  private spriteMaterial: THREE.MeshStandardMaterial | undefined;
  private videoElement: HTMLVideoElement | undefined;
  private videoCanvas: HTMLCanvasElement | undefined;
  private videoContext: CanvasRenderingContext2D | undefined;
  private videoTexture: THREE.CanvasTexture | undefined;
  private spriteMesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshStandardMaterial> | undefined;
  private transitionMesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshStandardMaterial> | undefined;
  private transitionMaterial: THREE.MeshStandardMaterial | undefined;
  private transitionCanvas: HTMLCanvasElement | undefined;
  private transitionContext: CanvasRenderingContext2D | undefined;
  private transitionTexture: THREE.CanvasTexture | undefined;
  private spriteMaskImage: CanvasImageSource | undefined;
  private spriteMaskCanvas: HTMLCanvasElement | undefined;
  private spriteMaskContext: CanvasRenderingContext2D | undefined;
  private usingVideo = false;
  private videoHasAlpha = false;
  private videoAlphaCheckPending = false;
  private styleAssets: PetStyleAssetUrls;
  private styleAssetSignature = "";
  private styleIsCustom = false;
  private lastVideoTime = -1;
  private transitionActive = false;
  private transitionAwaitingVideoFrame = false;
  private transitionElapsed = 0;
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  private readonly clock = new THREE.Clock();
  private frameId: number | undefined;
  private lastRenderTime = 0;
  private elapsed = 0;
  private frameElapsed = 0;
  private frameIndex = 0;
  private state: string = "idle";
  private targetYaw = 0;
  private currentYaw = 0;
  private currentPetOffsetY = 0;
  private currentPetTilt = 0;
  private currentCardRotationZ = 0;
  private currentCardRotationX = 0;
  private pointerDown = false;
  private dragging = false;
  private pointerStartX = 0;
  private pointerStartY = 0;
  private yawAtPointerStart = 0;
  private moveWindowDrag = true;
  private hovered = false;
  private shapeDirty = true;
  private lastShapeUpdate = 0;
  private lastShapeSignature = "";
  private lastVisualBoundsSignature = "";

  private readonly handleResize = (): void => this.resize();
  private readonly handleVisibility = (): void => {
    if (document.hidden) {
      if (this.pointerDown && this.dragging && this.moveWindowDrag) this.onMoveWindowEnd?.();
      this.pointerDown = false;
      this.dragging = false;
      this.setHovered(false);
      return;
    }
    this.clock.start();
  };
  private readonly handlePointerDown = (event: PointerEvent): void => {
    const hit = this.updatePointer(event);
    this.setHovered(hit);
    if (!hit) return;
    if (event.button !== 0) return;

    this.pointerDown = true;
    this.dragging = false;
    this.pointerStartX = event.clientX;
    this.pointerStartY = event.clientY;
    this.yawAtPointerStart = this.targetYaw;
    this.moveWindowDrag = !event.shiftKey;
    this.canvas.setPointerCapture(event.pointerId);
    event.preventDefault();
    event.stopPropagation();
  };
  private readonly handlePointerMove = (event: PointerEvent): void => {
    if (this.pointerDown && this.dragging && this.moveWindowDrag) {
      if (event.buttons === 0) {
        this.handlePointerUp(event);
        return;
      }
      this.onMoveWindow?.();
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    const hit = this.updatePointer(event);
    if (!this.pointerDown || !this.dragging) this.setHovered(hit);
    if (!this.pointerDown) {
      return;
    }

    if (event.buttons === 0) {
      this.handlePointerUp(event);
      return;
    }

    const deltaX = event.clientX - this.pointerStartX;
    const deltaY = event.clientY - this.pointerStartY;
    if (!this.dragging && Math.hypot(deltaX, deltaY) > 6) {
      this.dragging = true;
      if (this.moveWindowDrag) this.onMoveWindowStart?.();
    }
    if (this.dragging) {
      if (!this.moveWindowDrag) {
        this.targetYaw = THREE.MathUtils.clamp(this.yawAtPointerStart + deltaX * 0.012, -1.35, 1.35);
      }
    }
    event.preventDefault();
    event.stopPropagation();
  };
  private readonly handleContextMenu = (event: MouseEvent): void => {
    if (!this.updatePointer(event as PointerEvent)) return;
    event.preventDefault();
    event.stopPropagation();
    this.onContextMenu?.();
  };
  private readonly handlePointerUp = (event: PointerEvent): void => {
    if (this.pointerDown && !this.dragging && this.hovered) this.onTap?.();
    if (this.pointerDown && this.dragging && this.moveWindowDrag) this.onMoveWindowEnd?.();
    this.pointerDown = false;
    this.dragging = false;
    this.setHovered(false);
    if (this.canvas.hasPointerCapture(event.pointerId)) {
      this.canvas.releasePointerCapture(event.pointerId);
    }
    event.preventDefault();
    event.stopPropagation();
  };
  private readonly handlePointerCancel = (event: PointerEvent): void => {
    if (this.pointerDown && this.dragging && this.moveWindowDrag) this.onMoveWindowEnd?.();
    this.pointerDown = false;
    this.dragging = false;
    this.setHovered(false);
    if (this.canvas.hasPointerCapture(event.pointerId)) {
      this.canvas.releasePointerCapture(event.pointerId);
    }
    event.preventDefault();
    event.stopPropagation();
  };
  private readonly handleWindowBlur = (): void => {
    if (this.pointerDown && this.dragging && this.moveWindowDrag) this.onMoveWindowEnd?.();
    this.pointerDown = false;
    this.dragging = false;
    this.setHovered(false);
  };
  private readonly handlePointerLeave = (): void => {
    if (!this.pointerDown) {
      this.setHovered(false);
      this.targetYaw = 0;
    }
  };

  constructor(canvas: HTMLCanvasElement, options: ThreePetSceneOptions = {}) {
    this.canvas = canvas;
    this.onTap = options.onTap;
    this.onMoveWindowStart = options.onMoveWindowStart;
    this.onMoveWindow = options.onMoveWindow;
    this.onMoveWindowEnd = options.onMoveWindowEnd;
    this.onWindowShapeChange = options.onWindowShapeChange;
    this.onPetVisualBoundsChange = options.onPetVisualBoundsChange;
    this.onContextMenu = options.onContextMenu;
    this.onHoverChange = options.onHoverChange;
    this.onVideoWarning = options.onVideoWarning;
    this.styleAssets = options.petStyleAssets ?? DEFAULT_PET_STYLE_ASSETS;
    this.styleIsCustom = options.petStyleIsCustom === true;
    this.styleAssetSignature = JSON.stringify(this.styleAssets);

    try {
      const renderer = new THREE.WebGLRenderer({
        canvas,
        alpha: true,
        antialias: false,
        powerPreference: "low-power",
      });
      renderer.setClearColor(0x000000, 0);
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.25));
      renderer.shadowMap.enabled = false;
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      this.renderer = renderer;

      this.scene = new THREE.Scene();
      this.camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
      this.camera.position.set(0, 1.05, 5.25);
      this.camera.lookAt(0, 1.05, 0);

      this.addLights();
      this.buildSpritePet();
      this.resize();
      this.bindEvents();
      this.start();
      this.onHoverChange?.(false);
      this.available = true;
    } catch (error) {
      console.warn("3D pet unavailable; falling back to the sprite pet.", error);
      this.available = false;
      this.renderer?.dispose();
      this.canvas.style.display = "none";
      this.onHoverChange?.(false);
    }
  }

  setState(state: string): void {
    if (this.state !== state) {
      const transitionCaptured = this.captureTransitionFrame();
      const waitForVideoFrame = transitionCaptured && this.usingVideo;
      this.state = state;
      this.frameIndex = 0;
      this.frameElapsed = 0;
      this.prepareVideo(state);
      this.setFrame(0);
      this.transitionAwaitingVideoFrame = waitForVideoFrame;
      this.shapeDirty = true;
    }
  }

  setPetStyleAssets(assets: PetStyleAssetUrls, isCustom: boolean): void {
    const signature = JSON.stringify(assets);
    if (signature === this.styleAssetSignature && isCustom === this.styleIsCustom) return;

    const transitionCaptured = this.captureTransitionFrame();
    const waitForVideoFrame = transitionCaptured && Boolean(this.videoElement);
    this.styleAssets = assets;
    this.styleAssetSignature = signature;
    this.styleIsCustom = isCustom;
    this.prepareVideo(this.state);
    this.transitionAwaitingVideoFrame = waitForVideoFrame;
    this.shapeDirty = true;
  }

  resize(): void {
    if (!this.renderer || !this.camera) return;
    const width = Math.max(1, this.canvas.clientWidth);
    const height = Math.max(1, this.canvas.clientHeight);
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  destroy(): void {
    if (this.frameId !== undefined) {
      cancelAnimationFrame(this.frameId);
      this.frameId = undefined;
    }
    window.removeEventListener("resize", this.handleResize);
    document.removeEventListener("visibilitychange", this.handleVisibility);
    window.removeEventListener("blur", this.handleWindowBlur);
    this.canvas.removeEventListener("pointerdown", this.handlePointerDown);
    this.canvas.removeEventListener("contextmenu", this.handleContextMenu);
    this.canvas.removeEventListener("pointermove", this.handlePointerMove);
    this.canvas.removeEventListener("pointerup", this.handlePointerUp);
    this.canvas.removeEventListener("pointercancel", this.handlePointerCancel);
    this.canvas.removeEventListener("pointerleave", this.handlePointerLeave);
    if (this.pointerDown && this.dragging && this.moveWindowDrag) this.onMoveWindowEnd?.();
    this.setHovered(false);

    this.scene?.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      object.geometry.dispose();
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      materials.forEach((material) => material.dispose());
    });
    if (this.videoElement) {
      this.videoElement.pause();
      this.videoElement.removeAttribute("src");
      this.videoElement.load();
      this.videoElement.remove();
    }
    this.videoTexture?.dispose();
    this.spriteTexture?.dispose();
    this.renderer?.dispose();
  }

  private addLights(): void {
    if (!this.scene) return;

    this.scene.add(new THREE.HemisphereLight(0xf7f9ff, 0x8ba1c0, 1.7));

    const key = new THREE.DirectionalLight(0xffffff, 2.4);
    key.position.set(-3, 4.5, 4);
    key.castShadow = true;
    key.shadow.mapSize.set(512, 512);
    key.shadow.camera.near = 0.5;
    key.shadow.camera.far = 12;
    key.shadow.camera.left = -3;
    key.shadow.camera.right = 3;
    key.shadow.camera.top = 3;
    key.shadow.camera.bottom = -2;
    this.scene.add(key);

    const fill = new THREE.DirectionalLight(0x9fc7ff, 1.05);
    fill.position.set(3, 2, 3);
    this.scene.add(fill);
  }

  private buildSpritePet(): void {
    if (!this.scene) return;

    const root = new THREE.Group();
    root.position.y = 0.02;
    this.petRoot = root;

    const card = new THREE.Group();
    card.position.set(0, 1.02, 0.04);
    card.scale.set(1.06, 1.06, 1.06);
    this.spriteCard = card;
    root.add(card);

    const material = new THREE.MeshStandardMaterial({
      transparent: true,
      alphaTest: 0.025,
      roughness: 0.9,
      metalness: 0,
      side: THREE.DoubleSide,
    });
    this.spriteMaterial = material;

    const spriteMesh = new THREE.Mesh(new THREE.PlaneGeometry(1.62, 1.377), material);
    spriteMesh.castShadow = false;
    this.spriteMesh = spriteMesh;
    card.add(spriteMesh);

    const transitionMaterial = new THREE.MeshStandardMaterial({
      transparent: true,
      alphaTest: 0.025,
      opacity: 0,
      depthTest: false,
      depthWrite: false,
      roughness: 0.9,
      metalness: 0,
      side: THREE.DoubleSide,
    });
    this.transitionMaterial = transitionMaterial;

    const transitionMesh = new THREE.Mesh(new THREE.PlaneGeometry(1.62, 1.377), transitionMaterial);
    transitionMesh.visible = false;
    transitionMesh.renderOrder = 1;
    this.transitionMesh = transitionMesh;
    card.add(transitionMesh);

    const textureUrl = new URL("../../../assets/penguin/_sheet_top.png", import.meta.url).href;
    const texture = new THREE.TextureLoader().load(
      textureUrl,
      (loadedTexture) => {
        loadedTexture.colorSpace = THREE.SRGBColorSpace;
        loadedTexture.wrapS = THREE.ClampToEdgeWrapping;
        loadedTexture.wrapT = THREE.ClampToEdgeWrapping;
        loadedTexture.magFilter = THREE.LinearFilter;
        loadedTexture.minFilter = THREE.LinearFilter;
        this.spriteMaskImage = loadedTexture.image as CanvasImageSource;
        this.spriteMaskCanvas = document.createElement("canvas");
        this.spriteMaskCanvas.width = 80;
        this.spriteMaskCanvas.height = 68;
        this.spriteMaskContext = this.spriteMaskCanvas.getContext("2d", { willReadFrequently: true }) ?? undefined;
        loadedTexture.needsUpdate = true;
        this.setFrame(0);
      },
      undefined,
      (error) => console.warn("Unable to load the original penguin sprite sheet.", error),
    );
    this.spriteTexture = texture;
    material.map = texture;
    material.needsUpdate = true;
    this.setupVideo();

    this.scene.add(root);
    this.setFrame(0);
  }

  private setupVideo(): void {
    if (!this.spriteMaterial) return;

    const canvas = document.createElement("canvas");
    canvas.width = 360;
    canvas.height = 360;
    this.videoCanvas = canvas;
    this.videoContext = canvas.getContext("2d", { willReadFrequently: true }) ?? undefined;

    const transitionCanvas = document.createElement("canvas");
    transitionCanvas.width = canvas.width;
    transitionCanvas.height = canvas.height;
    this.transitionCanvas = transitionCanvas;
    this.transitionContext = transitionCanvas.getContext("2d", { willReadFrequently: true }) ?? undefined;

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.needsUpdate = true;
    this.videoTexture = texture;

    const transitionTexture = new THREE.CanvasTexture(transitionCanvas);
    transitionTexture.colorSpace = THREE.SRGBColorSpace;
    transitionTexture.minFilter = THREE.LinearFilter;
    transitionTexture.magFilter = THREE.LinearFilter;
    transitionTexture.needsUpdate = true;
    this.transitionTexture = transitionTexture;
    if (this.transitionMaterial) {
      this.transitionMaterial.map = transitionTexture;
      this.transitionMaterial.needsUpdate = true;
    }

    const video = document.createElement("video");
    video.muted = true;
    video.loop = true;
    video.playsInline = true;
    video.preload = "auto";
    video.setAttribute("aria-hidden", "true");
    video.style.display = "none";
    video.addEventListener("loadeddata", () => {
      this.usingVideo = true;
      this.videoAlphaCheckPending = true;
      this.lastVideoTime = -1;
      this.shapeDirty = true;
      // Every action is presented on the same square card. Keep the card
      // square, but let the frame renderer fit the source by its longest edge
      // so wide/tall custom artwork stays complete instead of being cropped.
      if (this.spriteMesh) this.spriteMesh.scale.x = VIDEO_PLANE_SCALE_X;
      if (this.transitionMesh) this.transitionMesh.scale.x = VIDEO_PLANE_SCALE_X;
      this.spriteMaterial!.map = this.videoTexture ?? null;
      this.spriteMaterial!.needsUpdate = true;
    });
    video.addEventListener("error", () => {
      console.warn("Video action unavailable; using the original sprite sheet instead.", video.src);
      if (this.styleIsCustom) {
        this.onVideoWarning?.("当前宠物状态视频无法播放，已回退默认企鹅。请确认文件是 WebM Alpha 视频。");
        this.styleIsCustom = false;
        this.styleAssets = DEFAULT_PET_STYLE_ASSETS;
        this.prepareVideo(this.state);
        return;
      }
      this.usingVideo = false;
      this.videoHasAlpha = false;
      this.transitionAwaitingVideoFrame = false;
      this.shapeDirty = true;
      if (this.spriteMesh) this.spriteMesh.scale.x = 1;
      if (this.transitionMesh) this.transitionMesh.scale.x = 1;
      this.spriteMaterial!.map = this.spriteTexture ?? null;
      this.spriteMaterial!.needsUpdate = true;
    });
    this.videoElement = video;
    document.body.appendChild(video);
    this.prepareVideo(this.state);
  }

  private prepareVideo(state: string): void {
    if (!this.videoElement) return;
    const runtimeState = this.styleAssets.cycleStates.find((item) => item.id === state);
    const fallbackState = runtimeState?.fallbackState ?? "idle";
    const videoUrl = this.styleAssets.assets[state]
      || this.styleAssets.assets[fallbackState]
      || new URL(`../../../video/alpha-webm/${ALPHA_VIDEO_FILES[fallbackState]}`, import.meta.url).href;
    this.usingVideo = false;
    this.videoHasAlpha = false;
    this.videoAlphaCheckPending = true;
    this.lastVideoTime = -1;
    this.shapeDirty = true;
    if (this.spriteMesh) this.spriteMesh.scale.x = VIDEO_PLANE_SCALE_X;
    if (this.transitionMesh) this.transitionMesh.scale.x = VIDEO_PLANE_SCALE_X;
    this.videoElement.src = videoUrl;
    this.videoElement.load();
    void this.videoElement.play().catch(() => {
      // Muted autoplay is normally allowed; the first render will retry when
      // the user interacts with the pet if the platform blocks it initially.
    });
  }

  private captureTransitionFrame(): boolean {
    const context = this.transitionContext;
    const texture = this.transitionTexture;
    const material = this.transitionMaterial;
    const mesh = this.transitionMesh;
    if (!context || !texture || !material || !mesh) return false;

    context.clearRect(0, 0, context.canvas.width, context.canvas.height);
    if (this.usingVideo && this.videoCanvas) {
      context.drawImage(this.videoCanvas, 0, 0, context.canvas.width, context.canvas.height);
    } else if (this.spriteMaskImage) {
      const definition = this.frameDefinition();
      const x = 143 + this.frameIndex * 80;
      context.drawImage(this.spriteMaskImage, x, definition.y, 80, 68, 0, 0, context.canvas.width, context.canvas.height);
    } else {
      return false;
    }

    texture.needsUpdate = true;
    material.opacity = 1;
    this.spriteMaterial!.opacity = 0;
    this.spriteMesh!.scale.y = 0.96;
    this.spriteMesh!.position.y = -0.012;
    mesh.scale.y = 1.018;
    mesh.position.y = 0.012;
    mesh.visible = true;
    this.transitionActive = true;
    this.transitionElapsed = 0;
    return true;
  }

  private updateTransition(delta: number): void {
    if (!this.transitionActive || this.transitionAwaitingVideoFrame || !this.transitionMaterial || !this.transitionMesh) {
      return;
    }

    this.transitionElapsed += delta * 1000;
    const progress = Math.min(1, this.transitionElapsed / STATE_TRANSITION_DURATION_MS);
    const eased = 0.5 - Math.cos(progress * Math.PI) * 0.5;
    this.transitionMaterial.opacity = 1 - eased;
    this.spriteMaterial!.opacity = eased;
    this.spriteMesh!.scale.y = 0.96 + eased * 0.04;
    this.spriteMesh!.position.y = -0.012 * (1 - eased);
    this.transitionMesh.scale.y = 1 + (1 - eased) * 0.018;
    this.transitionMesh.position.y = 0.012 * (1 - eased);
    if (progress >= 1) {
      this.transitionActive = false;
      this.transitionMesh.visible = false;
      this.transitionMaterial.opacity = 0;
      this.spriteMaterial!.opacity = 1;
      this.spriteMesh!.scale.y = 1;
      this.spriteMesh!.position.y = 0;
      this.transitionMesh.scale.y = 1;
      this.transitionMesh.position.y = 0;
    }
  }

  private updateVideoFrame(): void {
    const video = this.videoElement;
    const canvas = this.videoCanvas;
    const context = this.videoContext;
    const texture = this.videoTexture;
    if (!this.usingVideo || !video || !canvas || !context || !texture || video.readyState < 2) return;
    if (video.currentTime === this.lastVideoTime) return;

    const sourceWidth = video.videoWidth || 720;
    const sourceHeight = video.videoHeight || 720;
    // Normalize every source into the square transparent canvas by its
    // longest edge. The shorter edge keeps transparent breathing room, which
    // preserves the complete silhouette for landscape and portrait assets.
    const longestEdge = Math.max(sourceWidth, sourceHeight);
    const fitScale = Math.min(canvas.width, canvas.height) / longestEdge;
    const drawWidth = Math.max(1, Math.round(sourceWidth * fitScale));
    const drawHeight = Math.max(1, Math.round(sourceHeight * fitScale));
    const drawX = Math.round((canvas.width - drawWidth) / 2);
    const drawY = Math.round((canvas.height - drawHeight) / 2);

    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(video, 0, 0, sourceWidth, sourceHeight, drawX, drawY, drawWidth, drawHeight);
    if (this.videoAlphaCheckPending) {
      this.videoAlphaCheckPending = false;
      this.videoHasAlpha = this.detectVideoAlpha(context, drawX, drawY, drawWidth, drawHeight);
      if (!this.videoHasAlpha && this.styleIsCustom) {
        this.onVideoWarning?.("当前宠物视频没有检测到 Alpha 通道，已回退默认企鹅。请从剪映导出真正透明的 WebM 视频。");
        this.styleIsCustom = false;
        this.styleAssets = DEFAULT_PET_STYLE_ASSETS;
        this.prepareVideo(this.state);
        return;
      }
    }
    if (!this.videoHasAlpha) {
      const image = context.getImageData(0, 0, canvas.width, canvas.height);
      this.removeConnectedBlackBackground(image);
      context.putImageData(image, 0, 0);
    }
    texture.needsUpdate = true;
    this.lastVideoTime = video.currentTime;
    if (this.transitionAwaitingVideoFrame) {
      this.transitionAwaitingVideoFrame = false;
      this.transitionElapsed = 0;
    }
    this.shapeDirty = true;
  }

  private detectVideoAlpha(context: CanvasRenderingContext2D, drawX: number, drawY: number, drawWidth: number, drawHeight: number): boolean {
    const image = context.getImageData(0, 0, context.canvas.width, context.canvas.height);
    const stride = 8;
    const left = Math.max(0, drawX);
    const top = Math.max(0, drawY);
    const right = Math.min(image.width, drawX + drawWidth);
    const bottom = Math.min(image.height, drawY + drawHeight);
    for (let y = top; y < bottom; y += stride) {
      for (let x = left; x < right; x += stride) {
        if (image.data[(y * image.width + x) * 4 + 3] < 245) return true;
      }
    }
    return false;
  }

  /**
   * Extract a soft alpha matte from the black background.
   *
   * Only pixels connected to the video edge are treated as background. This
   * keeps the penguin's internal black feathers, eyes and feet intact while
   * retaining the feathered transition from the original cutout.
   */
  private removeConnectedBlackBackground(image: ImageData): void {
    const { data, width, height } = image;
    const background = new Uint8Array(width * height);
    const floodQueue: number[] = [];
    const softDistance = new Int16Array(width * height);
    softDistance.fill(-1);
    const backgroundThreshold = 48;

    const isBackgroundBlack = (pixel: number): boolean => {
      const offset = pixel * 4;
      return (
        data[offset] < backgroundThreshold &&
        data[offset + 1] < backgroundThreshold &&
        data[offset + 2] < backgroundThreshold
      );
    };
    const pushIfBlack = (x: number, y: number): void => {
      const pixel = y * width + x;
      if (!background[pixel] && isBackgroundBlack(pixel)) floodQueue.push(pixel);
    };

    for (let x = 0; x < width; x += 1) {
      pushIfBlack(x, 0);
      pushIfBlack(x, height - 1);
    }
    for (let y = 1; y < height - 1; y += 1) {
      pushIfBlack(0, y);
      pushIfBlack(width - 1, y);
    }

    while (floodQueue.length > 0) {
      const pixel = floodQueue.pop()!;
      if (background[pixel] || !isBackgroundBlack(pixel)) continue;
      background[pixel] = 1;
      const x = pixel % width;
      const y = Math.floor(pixel / width);
      if (x > 0) pushIfBlack(x - 1, y);
      if (x < width - 1) pushIfBlack(x + 1, y);
      if (y > 0) pushIfBlack(x, y - 1);
      if (y < height - 1) pushIfBlack(x, y + 1);
    }

    // Build a very small distance field around the detected background. The
    // soft band is deliberately limited to three pixels so it cannot eat into
    // the penguin's dark feathers.
    const softQueue: number[] = [];
    for (let pixel = 0; pixel < background.length; pixel += 1) {
      if (background[pixel]) {
        softDistance[pixel] = 0;
        softQueue.push(pixel);
      }
    }
    let softQueueIndex = 0;
    while (softQueueIndex < softQueue.length) {
      const pixel = softQueue[softQueueIndex];
      softQueueIndex += 1;
      const distance = softDistance[pixel];
      if (distance >= 3) continue;
      const x = pixel % width;
      const y = Math.floor(pixel / width);
      for (const [nextX, nextY] of [
        [x - 1, y - 1],
        [x, y - 1],
        [x + 1, y - 1],
        [x - 1, y],
        [x + 1, y],
        [x - 1, y + 1],
        [x, y + 1],
        [x + 1, y + 1],
      ]) {
        if (nextX < 0 || nextX >= width || nextY < 0 || nextY >= height) continue;
        const nextPixel = nextY * width + nextX;
        if (softDistance[nextPixel] === -1) {
          softDistance[nextPixel] = distance + 1;
          softQueue.push(nextPixel);
        }
      }
    }

    for (let pixel = 0; pixel < softDistance.length; pixel += 1) {
      const distance = softDistance[pixel];
      if (distance < 0 || distance > 3) continue;
      const alpha = distance === 0 ? 0 : distance === 1 ? 0.32 : distance === 2 ? 0.72 : 0.96;
      const offset = pixel * 4;
      if (alpha === 0) {
        data[offset + 3] = 0;
      } else {
        // Restore the edge color after making its alpha soft, preventing a
        // dark/gray fringe from the original black compositing background.
        data[offset] = Math.min(255, data[offset] / alpha);
        data[offset + 1] = Math.min(255, data[offset + 1] / alpha);
        data[offset + 2] = Math.min(255, data[offset + 2] / alpha);
        data[offset + 3] = Math.round(alpha * 255);
      }
    }
  }

  private bindEvents(): void {
    window.addEventListener("resize", this.handleResize);
    window.addEventListener("blur", this.handleWindowBlur);
    document.addEventListener("visibilitychange", this.handleVisibility);
    this.canvas.addEventListener("pointerdown", this.handlePointerDown);
    this.canvas.addEventListener("contextmenu", this.handleContextMenu);
    this.canvas.addEventListener("pointermove", this.handlePointerMove);
    this.canvas.addEventListener("pointerup", this.handlePointerUp);
    this.canvas.addEventListener("pointercancel", this.handlePointerCancel);
    this.canvas.addEventListener("pointerleave", this.handlePointerLeave);
  }

  private start(): void {
    const tick = (): void => {
      if (!this.renderer || !this.scene || !this.camera) return;
      this.frameId = requestAnimationFrame(tick);
      if (document.hidden) return;

      const now = performance.now();
      if (now - this.lastRenderTime < RENDER_INTERVAL_MS) return;
      this.lastRenderTime = now;

      const delta = Math.min(this.clock.getDelta(), 0.05);
      this.elapsed += delta;
      this.update(delta);
      this.renderer.render(this.scene, this.camera);
    };
    this.clock.start();
    tick();
  }

  private update(delta: number): void {
    if (!this.petRoot || !this.spriteCard) return;

    this.updateVideoFrame();
    this.updateTransition(delta);

    const frame = this.frameDefinition();
    this.frameElapsed += delta * 1000;
    if (this.frameElapsed >= frame.duration) {
      this.frameElapsed %= frame.duration;
      this.frameIndex = (this.frameIndex + 1) % 12;
      this.setFrame(this.frameIndex);
    }

    const time = this.elapsed;
    const breath = Math.sin(time * 2.15) * 0.025;
    const targetBob = this.state === "happy" ? Math.abs(Math.sin(time * 6.4)) * 0.09 : breath;
    const targetTilt = this.state === "angry" ? Math.sin(time * 9) * 0.035 : Math.sin(time * 1.1) * 0.018;
    const targetPetOffsetY = targetBob + (this.state === "sleep" ? -0.05 : 0);
    const targetCardRotationZ = this.state === "shy" ? -0.08 : 0;
    const targetCardRotationX = this.state === "sleep" ? 0.08 : 0;

    this.currentYaw = THREE.MathUtils.damp(this.currentYaw, this.targetYaw, 7, delta);
    this.currentPetOffsetY = THREE.MathUtils.damp(this.currentPetOffsetY, targetPetOffsetY, 12, delta);
    this.currentPetTilt = THREE.MathUtils.damp(this.currentPetTilt, targetTilt, 12, delta);
    this.currentCardRotationZ = THREE.MathUtils.damp(this.currentCardRotationZ, targetCardRotationZ, 10, delta);
    this.currentCardRotationX = THREE.MathUtils.damp(this.currentCardRotationX, targetCardRotationX, 10, delta);
    this.petRoot.rotation.y = this.currentYaw;
    this.petRoot.rotation.z = this.currentPetTilt;
    this.petRoot.position.y = this.currentPetOffsetY;
    this.spriteCard.rotation.z = this.currentCardRotationZ;
    this.spriteCard.rotation.x = this.currentCardRotationX;
    this.spriteCard.position.y = 1.02 + (this.state === "sleep" ? -0.04 : 0);
    this.updateWindowShape();
  }

  private updateWindowShape(): void {
    if ((!this.onWindowShapeChange && !this.onPetVisualBoundsChange) || !this.camera || !this.spriteMesh) return;
    // Do not replace the native hit-test region while the pointer is held.
    // Animated alpha edges can otherwise make a border drag jump between
    // neighboring pixel rows.
    if (this.pointerDown) return;

    const now = performance.now();
    if (now - this.lastShapeUpdate < SHAPE_UPDATE_INTERVAL_MS) return;

    const sourceCanvas = this.usingVideo ? this.videoCanvas : this.spriteMaskCanvas;
    const sourceContext = this.usingVideo ? this.videoContext : this.spriteMaskContext;
    if (!sourceCanvas || !sourceContext || sourceCanvas.width <= 0 || sourceCanvas.height <= 0) return;

    const bounds = this.projectedSpriteBounds();
    if (!bounds) return;

    const image = sourceContext.getImageData(0, 0, sourceCanvas.width, sourceCanvas.height);
    const rects = this.alphaImageToShapeRects(image, bounds);
    const shapeArea = rects.reduce((area, rect) => area + rect.width * rect.height, 0);
    const boundsArea = Math.max(1, bounds.width * bounds.height);
    if (
      rects.length === 0 ||
      rects.length > MAX_STABLE_SHAPE_RECTS ||
      shapeArea / boundsArea < MIN_STABLE_SHAPE_COVERAGE
    ) {
      // Keep the last known-good native region when a video frame is only
      // partially decoded and produces scattered alpha samples.
      this.lastShapeUpdate = now;
      return;
    }

    const visualBounds = this.alphaShapeBounds(rects);
    if (visualBounds) {
      const visualSignature = [
        visualBounds.left,
        visualBounds.top,
        visualBounds.width,
        visualBounds.height,
      ].join(",");
      if (visualSignature !== this.lastVisualBoundsSignature) {
        this.lastVisualBoundsSignature = visualSignature;
        this.onPetVisualBoundsChange?.(visualBounds);
      }
    }

    const signature = rects.map((rect) => `${rect.x},${rect.y},${rect.width},${rect.height}`).join(";");
    if (signature !== this.lastShapeSignature) {
      this.lastShapeSignature = signature;
      this.onWindowShapeChange?.(rects);
    }
    this.shapeDirty = false;
    this.lastShapeUpdate = now;
  }

  private alphaShapeBounds(rects: WindowShapeRect[]): PetVisualBounds | undefined {
    if (rects.length === 0) return undefined;

    let left = Number.POSITIVE_INFINITY;
    let top = Number.POSITIVE_INFINITY;
    let right = Number.NEGATIVE_INFINITY;
    let bottom = Number.NEGATIVE_INFINITY;
    for (const rect of rects) {
      left = Math.min(left, rect.x);
      top = Math.min(top, rect.y);
      right = Math.max(right, rect.x + rect.width);
      bottom = Math.max(bottom, rect.y + rect.height);
    }

    if (!Number.isFinite(left) || !Number.isFinite(top) || right <= left || bottom <= top) {
      return undefined;
    }
    return { left, top, width: right - left, height: bottom - top };
  }

  private projectedSpriteBounds(): PetVisualBounds | undefined {
    if (!this.camera || !this.spriteMesh) return undefined;
    const position = this.spriteMesh.geometry.getAttribute("position");
    if (!position) return undefined;

    this.scene?.updateMatrixWorld(true);
    const projected = new THREE.Vector3();
    const canvasWidth = this.canvas.clientWidth;
    const canvasHeight = this.canvas.clientHeight;
    let left = Number.POSITIVE_INFINITY;
    let top = Number.POSITIVE_INFINITY;
    let right = Number.NEGATIVE_INFINITY;
    let bottom = Number.NEGATIVE_INFINITY;

    for (let index = 0; index < position.count; index += 1) {
      projected.fromBufferAttribute(position, index).applyMatrix4(this.spriteMesh.matrixWorld).project(this.camera);
      const x = (projected.x * 0.5 + 0.5) * canvasWidth;
      const y = (-projected.y * 0.5 + 0.5) * canvasHeight;
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x);
      bottom = Math.max(bottom, y);
    }

    const clippedLeft = Math.max(0, Math.floor(left));
    const clippedTop = Math.max(0, Math.floor(top));
    const clippedRight = Math.min(canvasWidth, Math.ceil(right));
    const clippedBottom = Math.min(canvasHeight, Math.ceil(bottom));
    if (clippedRight <= clippedLeft || clippedBottom <= clippedTop) return undefined;
    return {
      left: clippedLeft,
      top: clippedTop,
      width: clippedRight - clippedLeft,
      height: clippedBottom - clippedTop,
    };
  }

  private alphaImageToShapeRects(
    image: ImageData,
    bounds: { left: number; top: number; width: number; height: number },
  ): WindowShapeRect[] {
    const rects: WindowShapeRect[] = [];
    let active = new Map<string, WindowShapeRect>();

    for (let maskY = 0; maskY < SHAPE_MASK_SIZE; maskY += 1) {
      const sourceY = Math.min(image.height - 1, Math.floor(((maskY + 0.5) * image.height) / SHAPE_MASK_SIZE));
      const spans: Array<{ start: number; end: number }> = [];
      let spanStart = -1;

      for (let maskX = 0; maskX < SHAPE_MASK_SIZE; maskX += 1) {
        const sourceX = Math.min(image.width - 1, Math.floor(((maskX + 0.5) * image.width) / SHAPE_MASK_SIZE));
        const alpha = image.data[(sourceY * image.width + sourceX) * 4 + 3];
        if (alpha >= SHAPE_ALPHA_THRESHOLD && spanStart < 0) spanStart = maskX;
        if ((alpha < SHAPE_ALPHA_THRESHOLD || maskX === SHAPE_MASK_SIZE - 1) && spanStart >= 0) {
          spans.push({ start: spanStart, end: alpha >= SHAPE_ALPHA_THRESHOLD ? maskX + 1 : maskX });
          spanStart = -1;
        }
      }

      const nextActive = new Map<string, WindowShapeRect>();
      for (const span of spans) {
        const left = Math.max(0, Math.floor(bounds.left + (span.start / SHAPE_MASK_SIZE) * bounds.width));
        const right = Math.min(
          this.canvas.clientWidth,
          Math.ceil(bounds.left + (span.end / SHAPE_MASK_SIZE) * bounds.width),
        );
        const top = Math.max(0, Math.floor(bounds.top + (maskY / SHAPE_MASK_SIZE) * bounds.height));
        const bottom = Math.min(
          this.canvas.clientHeight,
          Math.ceil(bounds.top + ((maskY + 1) / SHAPE_MASK_SIZE) * bounds.height),
        );
        if (right <= left || bottom <= top) continue;

        const key = `${left}:${right}`;
        const previous = active.get(key);
        if (previous && previous.y + previous.height === top) {
          previous.height = bottom - previous.y;
          nextActive.set(key, previous);
        } else {
          const rect = { x: left, y: top, width: right - left, height: bottom - top };
          rects.push(rect);
          nextActive.set(key, rect);
        }
      }
      active = nextActive;
    }

    return rects;
  }

  private frameDefinition(): SpriteFrame {
    const rows: Record<PetState, SpriteFrame> = {
      idle: { row: 0, y: 0, duration: 110 },
      walk: { row: 1, y: 80, duration: 90 },
      happy: { row: 2, y: 158, duration: 100 },
      shy: { row: 3, y: 236, duration: 125 },
      sleep: { row: 4, y: 315, duration: 140 },
      eat: { row: 5, y: 395, duration: 100 },
      angry: { row: 6, y: 478, duration: 95 },
    };
    const state = this.state in rows ? this.state as PetState : "idle";
    return rows[state];
  }

  private setFrame(frameIndex: number): void {
    if (!this.spriteTexture) return;
    const definition = this.frameDefinition();
    const sheetWidth = 1054;
    const sheetHeight = 760;
    const frameWidth = 80;
    const frameHeight = 68;
    const x = 143 + frameIndex * frameWidth;

    this.spriteTexture.repeat.set(frameWidth / sheetWidth, frameHeight / sheetHeight);
    this.spriteTexture.offset.set(x / sheetWidth, 1 - (definition.y + frameHeight) / sheetHeight);
    this.spriteTexture.needsUpdate = true;
    this.updateSpriteMask(x, definition.y, frameWidth, frameHeight);
    this.shapeDirty = true;
  }

  private updatePointer(event: PointerEvent): boolean {
    const bounds = this.canvas.getBoundingClientRect();
    this.pointer.x = ((event.clientX - bounds.left) / bounds.width) * 2 - 1;
    this.pointer.y = -((event.clientY - bounds.top) / bounds.height) * 2 + 1;
    if (!this.camera || !this.petRoot) return false;

    this.raycaster.setFromCamera(this.pointer, this.camera);
    const intersection = this.spriteMesh ? this.raycaster.intersectObject(this.spriteMesh, false)[0] : undefined;
    if (!intersection?.uv) return false;

    const textureX = Math.max(0, Math.min(0.999999, intersection.uv.x));
    const textureY = Math.max(0, Math.min(0.999999, 1 - intersection.uv.y));
    let alpha = 0;
    if (this.usingVideo && this.videoContext && this.videoCanvas) {
      const pixelX = Math.floor(textureX * this.videoCanvas.width);
      const pixelY = Math.floor(textureY * this.videoCanvas.height);
      alpha = this.videoContext.getImageData(pixelX, pixelY, 1, 1).data[3];
    } else if (this.spriteMaskContext && this.spriteMaskCanvas) {
      const pixelX = Math.floor(textureX * this.spriteMaskCanvas.width);
      const pixelY = Math.floor(textureY * this.spriteMaskCanvas.height);
      alpha = this.spriteMaskContext.getImageData(pixelX, pixelY, 1, 1).data[3];
    }

    const hit = alpha > 18;
    if (!this.pointerDown && hit) {
      this.targetYaw = THREE.MathUtils.clamp(this.pointer.x * 0.5, -0.5, 0.5);
    }
    return hit;
  }

  private setHovered(value: boolean): void {
    if (value === this.hovered) return;
    this.hovered = value;
    this.canvas.dataset.hovered = value ? "true" : "false";
    this.onHoverChange?.(value);
  }

  private updateSpriteMask(sourceX: number, sourceY: number, sourceWidth: number, sourceHeight: number): void {
    if (!this.spriteMaskImage || !this.spriteMaskContext || !this.spriteMaskCanvas) return;
    this.spriteMaskContext.clearRect(0, 0, this.spriteMaskCanvas.width, this.spriteMaskCanvas.height);
    this.spriteMaskContext.drawImage(
      this.spriteMaskImage,
      sourceX,
      sourceY,
      sourceWidth,
      sourceHeight,
      0,
      0,
      this.spriteMaskCanvas.width,
      this.spriteMaskCanvas.height,
    );
  }
}
