// WebGL water-ripple renderer.
//
// A height-field water simulation (classic 2D wave equation on a ping-pong
// framebuffer) runs continuously. Pointer movement and ambient drops inject
// ripples that propagate and refract whatever image is currently shown. Because
// the simulation is independent of the textures, ripples persist seamlessly
// across image crossfades — swapping the image never resets the water surface.
//
// Requires WebGL2 + a float-renderable colour buffer. If unavailable the stage
// degrades to a plain crossfade with no ripple distortion.

const VERT = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

// Wave step: next = (avg of 4 neighbours) - previous, damped; plus drop impulses.
const SIM_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uSim;     // .x = current height, .y = previous height
uniform vec2 uTexel;
uniform float uDamping;
uniform float uAspect;      // screen W/H, keeps drops circular
uniform vec4 uDrops[4];     // xy = uv pos, z = radius, w = strength

float dropAt(vec2 uv, vec4 drop) {
  if (drop.w == 0.0) return 0.0;
  vec2 p = uv - drop.xy;
  p.x *= uAspect;
  float d = length(p) / drop.z;
  if (d >= 1.0) return 0.0;
  return drop.w * 0.5 * (cos(d * 3.14159265) + 1.0);
}

void main() {
  vec2 me = texture(uSim, vUv).xy;
  float l = texture(uSim, vUv + vec2(-uTexel.x, 0.0)).x;
  float r = texture(uSim, vUv + vec2( uTexel.x, 0.0)).x;
  float u = texture(uSim, vUv + vec2(0.0, -uTexel.y)).x;
  float d = texture(uSim, vUv + vec2(0.0,  uTexel.y)).x;

  float next = (l + r + u + d) * 0.5 - me.y;
  next *= uDamping;
  for (int i = 0; i < 4; i++) next += dropAt(vUv, uDrops[i]);

  outColor = vec4(next, me.x, 0.0, 1.0);
}`;

// Render: refract the (crossfaded) image by the surface gradient, fill
// letterbox areas with a blurred + darkened cover sample, add a faint sheen.
const RENDER_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uSim;
uniform sampler2D uImgA;
uniform sampler2D uImgB;
uniform vec2 uTexel;
uniform float uAspect;      // screen W/H
uniform vec2 uSizeA;        // image A pixel size
uniform vec2 uSizeB;
uniform float uFade;        // 0 = A, 1 = B
uniform float uRefraction;

vec2 coverUv(vec2 s, vec2 img) {
  float ia = img.x / img.y;
  vec2 t = s;
  if (uAspect > ia) t.y = (s.y - 0.5) * (ia / uAspect) + 0.5;
  else              t.x = (s.x - 0.5) * (uAspect / ia) + 0.5;
  return t;
}

vec2 containUv(vec2 s, vec2 img) {
  float ia = img.x / img.y;
  vec2 t = s;
  if (uAspect > ia) t.x = (s.x - 0.5) * (uAspect / ia) + 0.5;
  else              t.y = (s.y - 0.5) * (ia / uAspect) + 0.5;
  return t;
}

vec3 sampleImg(sampler2D tex, vec2 size, vec2 s) {
  float ia = size.x / size.y;
  vec2 cuv = coverUv(s, size);
  vec3 bg = textureLod(tex, cuv, 7.0).rgb * 0.45;      // blurred letterbox fill
  if (ia >= uAspect * 0.95) return texture(tex, cuv).rgb;
  vec2 fuv = containUv(s, size);
  bool inside = all(greaterThanEqual(fuv, vec2(0.0))) && all(lessThanEqual(fuv, vec2(1.0)));
  return inside ? texture(tex, fuv).rgb : bg;
}

void main() {
  float l = texture(uSim, vUv + vec2(-uTexel.x, 0.0)).x;
  float r = texture(uSim, vUv + vec2( uTexel.x, 0.0)).x;
  float u = texture(uSim, vUv + vec2(0.0, -uTexel.y)).x;
  float d = texture(uSim, vUv + vec2(0.0,  uTexel.y)).x;
  vec2 grad = vec2(l - r, u - d);

  vec2 s = vUv + grad * uRefraction;
  vec3 col = mix(sampleImg(uImgA, uSizeA, s), sampleImg(uImgB, uSizeB, s), uFade);

  // Faint specular sheen along the wave slopes.
  vec3 normal = normalize(vec3(grad * 6.0, 1.0));
  float spec = pow(max(dot(normal, normalize(vec3(-0.4, 0.5, 1.0))), 0.0), 24.0);
  col += spec * 0.12;

  outColor = vec4(col, 1.0);
}`;

interface Drop { x: number; y: number; radius: number; strength: number; }

export class RippleStage {
  private gl: WebGL2RenderingContext;
  private ok = false;                 // float RT available → ripple enabled
  private simProg!: WebGLProgram;
  private renderProg!: WebGLProgram;
  private fbo: [WebGLFramebuffer, WebGLFramebuffer] = [null!, null!];
  private simTex: [WebGLTexture, WebGLTexture] = [null!, null!];
  private cur = 0;                     // index of the latest sim texture
  private simW = 256;
  private simH = 256;
  private simU: Record<string, WebGLUniformLocation | null> = {};
  private renderU: Record<string, WebGLUniformLocation | null> = {};
  private dropBuf = new Float32Array(16);

  private texA: WebGLTexture;
  private texB: WebGLTexture;
  private sizeA = new Float32Array([1, 1]);
  private sizeB = new Float32Array([1, 1]);
  private hasImage = false;

  private fade = 0;
  private fading = false;
  private fadeStart = 0;
  private fadeMs = 600;

  private drops: Drop[] = [];
  private lastPx = 0;
  private lastPy = 0;
  private hasLast = false;

  constructor(private canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: false });
    if (!gl) throw new Error('WebGL2 unavailable');
    this.gl = gl;
    this.ok = !!gl.getExtension('EXT_color_buffer_float');

    this.texA = gl.createTexture()!;
    this.texB = gl.createTexture()!;

    if (this.ok) {
      this.simProg = this.program(VERT, SIM_FRAG);
    }
    this.renderProg = this.program(VERT, RENDER_FRAG);
    this.cacheUniforms();
    this.setupQuad();
    this.resize();

    window.addEventListener('resize', () => this.resize());
    window.addEventListener('pointermove', (e) => this.onPointer(e), { passive: true });
    // Ambient drops so the surface is never perfectly still.
    setInterval(() => {
      if (document.hidden) return;
      this.addDrop(Math.random(), Math.random(), 0.03, 0.05);
    }, 2800);

    requestAnimationFrame((t) => this.frame(t));
  }

  // --- GL setup helpers ---------------------------------------------------
  private compile(type: number, src: string): WebGLShader {
    const gl = this.gl;
    const sh = gl.createShader(type)!;
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      throw new Error('shader: ' + gl.getShaderInfoLog(sh));
    }
    return sh;
  }

  private program(vs: string, fs: string): WebGLProgram {
    const gl = this.gl;
    const p = gl.createProgram()!;
    gl.attachShader(p, this.compile(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, this.compile(gl.FRAGMENT_SHADER, fs));
    gl.bindAttribLocation(p, 0, 'aPos');
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      throw new Error('link: ' + gl.getProgramInfoLog(p));
    }
    return p;
  }

  private cacheUniforms(): void {
    const gl = this.gl;
    if (this.ok) {
      for (const n of ['uSim', 'uTexel', 'uDamping', 'uAspect', 'uDrops']) {
        this.simU[n] = gl.getUniformLocation(this.simProg, n);
      }
    }
    for (const n of ['uSim', 'uImgA', 'uImgB', 'uTexel', 'uAspect', 'uSizeA', 'uSizeB', 'uFade', 'uRefraction']) {
      this.renderU[n] = gl.getUniformLocation(this.renderProg, n);
    }
  }

  private setupQuad(): void {
    const gl = this.gl;
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    // Single oversized triangle covering the viewport.
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  }

  private makeSimTexture(): WebGLTexture {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, this.simW, this.simH, 0, gl.RGBA, gl.HALF_FLOAT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  private resize(): void {
    const gl = this.gl;
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    const w = Math.round(window.innerWidth * dpr);
    const h = Math.round(window.innerHeight * dpr);
    this.canvas.width = w;
    this.canvas.height = h;
    gl.viewport(0, 0, w, h);

    if (!this.ok) return;
    // Square sim texels in screen space → circular ripples. Short side ~256.
    const aspect = window.innerWidth / window.innerHeight;
    if (aspect >= 1) { this.simH = 256; this.simW = Math.min(512, Math.round(256 * aspect)); }
    else { this.simW = 256; this.simH = Math.min(512, Math.round(256 / aspect)); }

    for (let i = 0; i < 2; i++) {
      if (this.simTex[i]) gl.deleteTexture(this.simTex[i]);
      if (this.fbo[i]) gl.deleteFramebuffer(this.fbo[i]);
      this.simTex[i] = this.makeSimTexture();
      this.fbo[i] = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo[i]);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.simTex[i], 0);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  // --- public API ---------------------------------------------------------
  // Accepts a pre-decoded ImageBitmap (created with imageOrientation:'flipY'),
  // so the only main-thread cost here is the GPU upload + mipmap build.
  setImage(bmp: ImageBitmap): void {
    const gl = this.gl;

    // If a crossfade is still running, snap it to done so no image is skipped.
    if (this.fading) {
      [this.texA, this.texB] = [this.texB, this.texA];
      this.sizeA.set(this.sizeB);
      this.fading = false;
      this.fade = 0;
    }

    const target = this.hasImage ? this.texB : this.texA;
    gl.bindTexture(gl.TEXTURE_2D, target);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bmp);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.generateMipmap(gl.TEXTURE_2D);

    const size = new Float32Array([bmp.width || 1, bmp.height || 1]);
    if (!this.hasImage) {
      this.sizeA.set(size);
      this.sizeB.set(size);          // B unused until first crossfade
      this.hasImage = true;
      this.fade = 0;
      return;
    }
    this.sizeB.set(size);
    this.fade = 0;
    this.fading = true;
    this.fadeStart = performance.now();
  }

  // --- ripple input -------------------------------------------------------
  private addDrop(x: number, y: number, radius: number, strength: number): void {
    if (this.drops.length >= 4) this.drops.shift();
    this.drops.push({ x, y, radius, strength });
  }

  private onPointer(e: PointerEvent): void {
    const x = e.clientX / window.innerWidth;
    const y = 1 - e.clientY / window.innerHeight;
    if (this.hasLast) {
      const speed = Math.hypot(x - this.lastPx, y - this.lastPy);
      const strength = Math.min(0.02 + speed * 1.5, 0.18);
      this.addDrop(x, y, 0.025, strength);
    }
    this.lastPx = x; this.lastPy = y; this.hasLast = true;
  }

  // --- frame loop ---------------------------------------------------------
  private frame(now: number): void {
    if (this.fading) {
      const t = Math.min((now - this.fadeStart) / this.fadeMs, 1);
      this.fade = t * t * (3 - 2 * t);   // smoothstep
      if (t >= 1) {
        // Promote the incoming image to A, ready for the next swap.
        [this.texA, this.texB] = [this.texB, this.texA];
        this.sizeA.set(this.sizeB);
        this.fade = 0;
        this.fading = false;
      }
    }

    if (this.ok) this.stepSim();
    this.render();
    requestAnimationFrame((t) => this.frame(t));
  }

  private stepSim(): void {
    const gl = this.gl;
    const src = this.cur;
    const dst = 1 - this.cur;
    gl.useProgram(this.simProg);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo[dst]);
    gl.viewport(0, 0, this.simW, this.simH);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.simTex[src]);
    gl.uniform1i(this.simU.uSim, 0);
    gl.uniform2f(this.simU.uTexel, 1 / this.simW, 1 / this.simH);
    gl.uniform1f(this.simU.uDamping, 0.985);
    gl.uniform1f(this.simU.uAspect, window.innerWidth / window.innerHeight);

    const arr = this.dropBuf;
    arr.fill(0);
    for (let i = 0; i < this.drops.length; i++) {
      const d = this.drops[i];
      arr[i * 4] = d.x; arr[i * 4 + 1] = d.y; arr[i * 4 + 2] = d.radius; arr[i * 4 + 3] = d.strength;
    }
    gl.uniform4fv(this.simU.uDrops, arr);
    this.drops.length = 0;             // drops are one-shot impulses

    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.cur = dst;
  }

  private render(): void {
    const gl = this.gl;
    if (!this.hasImage) return;
    gl.useProgram(this.renderProg);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.ok ? this.simTex[this.cur] : this.simTex[0] || null);
    gl.uniform1i(this.renderU.uSim, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.texA);
    gl.uniform1i(this.renderU.uImgA, 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.texB);
    gl.uniform1i(this.renderU.uImgB, 2);

    gl.uniform2f(this.renderU.uTexel, 1 / this.simW, 1 / this.simH);
    gl.uniform1f(this.renderU.uAspect, window.innerWidth / window.innerHeight);
    gl.uniform2fv(this.renderU.uSizeA, this.sizeA);
    gl.uniform2fv(this.renderU.uSizeB, this.sizeB);
    gl.uniform1f(this.renderU.uFade, this.fade);
    gl.uniform1f(this.renderU.uRefraction, this.ok ? 0.18 : 0.0);

    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}
