export interface AnimationDefinition {
  row: number;
  frameCount: number;
  frameDuration: number;
}

export type FrameListener = (frame: number, animation: string) => void;

export class AnimationManager {
  private readonly animations: Record<string, AnimationDefinition>;
  private timer: ReturnType<typeof setInterval> | undefined;
  private currentAnimation = "idle";
  private currentFrame = 0;
  private listener: FrameListener | undefined;

  constructor(animations: Record<string, AnimationDefinition>) {
    this.animations = animations;
  }

  play(animation: string, listener: FrameListener): void {
    const definition = this.animations[animation];
    if (!definition) {
      throw new Error(`Unknown animation: ${animation}`);
    }

    this.stop();
    this.currentAnimation = animation;
    this.currentFrame = 0;
    this.listener = listener;
    this.emitFrame();
    this.timer = setInterval(() => {
      this.currentFrame = (this.currentFrame + 1) % definition.frameCount;
      this.emitFrame();
    }, definition.frameDuration);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  destroy(): void {
    this.stop();
    this.listener = undefined;
  }

  getCurrentAnimation(): string {
    return this.currentAnimation;
  }

  private emitFrame(): void {
    this.listener?.(this.currentFrame, this.currentAnimation);
  }
}
