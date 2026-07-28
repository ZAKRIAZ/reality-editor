// ============ REALITY EDITOR — uber-shader ============
// All powers are procedural GLSL, applied only where the selection mask > 0.

export const VERT = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;          // 0..1, y up
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

export const FRAG = `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 outColor;

uniform sampler2D uVideo;   // live reality (mirrored sampling)
uniform sampler2D uMask;    // selection mask (soft edges)
uniform sampler2D uFrozen;  // captured frame for time-freeze
uniform sampler2D uPastA;   // ring-buffer frame (slow-mo / reverse / echo)
uniform sampler2D uPastB;   // older ring-buffer frame (echo)
uniform float uTime;
uniform int   uMode;
uniform vec2  uRes;
uniform vec2  uCenter;      // selection centroid, screen space 0..1 (y up)
uniform float uMirror;      // 1 = selfie mirror

// -------- sampling helpers (textures are top-left origin) --------
vec2 vidUv(vec2 uv) {
  float x = uMirror > 0.5 ? 1.0 - uv.x : uv.x;
  return vec2(x, 1.0 - uv.y);
}
vec3 video(vec2 uv)  { return texture(uVideo,  vidUv(clamp(uv, 0.001, 0.999))).rgb; }
vec3 frozen(vec2 uv) { return texture(uFrozen, vidUv(clamp(uv, 0.001, 0.999))).rgb; }
vec3 pastA(vec2 uv)  { return texture(uPastA,  vidUv(clamp(uv, 0.001, 0.999))).rgb; }
vec3 pastB(vec2 uv)  { return texture(uPastB,  vidUv(clamp(uv, 0.001, 0.999))).rgb; }
float mask(vec2 uv)  { return texture(uMask, vec2(uv.x, 1.0 - uv.y)).r; }

// -------- noise toolkit --------
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float hash1(float n) { return fract(sin(n) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x),
             mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) { v += a * noise(p); p = p * 2.03 + 17.1; a *= 0.5; }
  return v;
}
float ridged(vec2 p) { return 1.0 - abs(2.0 * fbm(p) - 1.0); }
vec3 hue(float h) {
  return clamp(abs(mod(h * 6.0 + vec3(0, 4, 2), 6.0) - 3.0) - 1.0, 0.0, 1.0);
}
float lum(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }

// -------- star field --------
float stars(vec2 uv, float density, float t) {
  vec2 g = uv * density;
  vec2 id = floor(g), f = fract(g);
  float h = hash(id);
  if (h < 0.82) return 0.0;
  vec2 pos = vec2(hash(id + 1.3), hash(id + 2.7));
  float d = length(f - pos);
  float tw = 0.6 + 0.4 * sin(t * (1.5 + h * 4.0) + h * 40.0);
  return smoothstep(0.09, 0.0, d) * tw;
}

// ================= DIMENSIONS =================

vec3 fxCosmic(vec2 uv, vec3 base, float t) {
  vec2 p = uv * vec2(uRes.x / uRes.y, 1.0);
  vec2 drift = vec2(t * 0.008, t * 0.003);
  float neb1 = fbm(p * 3.0 + drift * 4.0);
  float neb2 = fbm(p * 5.0 - drift * 6.0 + 40.0);
  vec3 nebula = vec3(0.30, 0.05, 0.45) * neb1 * neb1 * 1.6
              + vec3(0.05, 0.20, 0.55) * neb2 * neb2 * 1.4;
  float s = stars(p + drift, 60.0, t) + stars(p * 1.7 - drift * 2.0, 90.0, t) * 0.6;
  // slow-rotating galaxy near center
  vec2 d = uv - uCenter; d.x *= uRes.x / uRes.y;
  float r = length(d), ang = atan(d.y, d.x);
  float arm = sin(ang * 3.0 - r * 22.0 + t * 0.35);
  float gal = smoothstep(0.30, 0.0, r) * (0.5 + 0.5 * arm) * 0.55;
  vec3 col = vec3(0.01, 0.01, 0.03) + nebula + vec3(s) + vec3(0.9, 0.8, 1.0) * gal;
  return col + base * 0.10;                       // faint ghost of reality
}

vec3 fxCyberpunk(vec2 uv, vec3 base, float t) {
  vec3 c = base;
  float l = lum(c);
  // neon duotone grade
  vec3 grade = mix(vec3(0.05, 0.0, 0.25), vec3(0.0, 1.0, 0.95), smoothstep(0.1, 0.7, l));
  grade = mix(grade, vec3(1.0, 0.2, 0.8), smoothstep(0.75, 1.0, l));
  // edge neon: cheap sobel
  vec2 px = 1.5 / uRes;
  float gx = lum(video(uv + vec2(px.x, 0.))) - lum(video(uv - vec2(px.x, 0.)));
  float gy = lum(video(uv + vec2(0., px.y))) - lum(video(uv - vec2(0., px.y)));
  float edge = clamp(length(vec2(gx, gy)) * 6.0, 0.0, 1.0);
  vec3 neon = mix(vec3(1.0, 0.15, 0.8), vec3(0.1, 1.0, 1.0), hash1(floor(uv.y * 30.0)));
  // rain streaks
  float rain = smoothstep(0.92, 1.0, noise(vec2(uv.x * 120.0, uv.y * 8.0 + t * 6.0)));
  // scanlines + flicker
  float scan = 0.88 + 0.12 * sin(uv.y * uRes.y * 2.4 + t * 8.0);
  vec3 col = mix(c * 0.35, grade, 0.6) * scan + neon * edge * 0.9 + vec3(0.4, 0.9, 1.0) * rain * 0.35;
  return col;
}

vec3 fxUnderwater(vec2 uv, vec3 base, float t) {
  vec2 w = uv + vec2(sin(uv.y * 22.0 + t * 1.7), sin(uv.x * 18.0 + t * 2.1)) * 0.006;
  vec3 c = video(w);
  c = mix(c, c * vec3(0.30, 0.75, 0.95), 0.75);              // deep tint
  vec2 p = w * vec2(uRes.x / uRes.y, 1.0);
  float ca = ridged(p * 7.0 + vec2(t * 0.30, t * 0.18));      // caustics
  ca = pow(ca, 5.0);
  c += vec3(0.35, 0.8, 0.9) * ca * 0.55;
  float ray = pow(max(0.0, sin(uv.x * 9.0 + uv.y * 3.0 + t * 0.4)), 8.0);  // god rays
  c += vec3(0.2, 0.5, 0.6) * ray * (1.0 - uv.y) * 0.25;
  return c * (0.75 + 0.25 * uv.y);
}

vec3 fxLava(vec2 uv, vec3 base, float t) {
  // heat shimmer
  vec2 w = uv + vec2(noise(uv * 30.0 + t * 3.0) - 0.5, noise(uv * 30.0 - t * 2.5) - 0.5) * 0.008;
  vec3 c = video(w);
  vec2 p = w * vec2(uRes.x / uRes.y, 1.0);
  float crack = ridged(p * 6.0 + vec2(0.0, t * 0.12));
  crack = smoothstep(0.82, 0.99, crack);
  float flow = fbm(p * 4.0 + vec2(0.0, t * 0.25));
  vec3 lava = mix(vec3(1.0, 0.15, 0.0), vec3(1.0, 0.85, 0.2), flow);
  c = mix(c * vec3(0.9, 0.4, 0.25), c * vec3(0.4, 0.15, 0.1), uv.y);
  c += lava * crack * (1.4 + 0.4 * sin(t * 3.0 + uv.x * 20.0));
  c += vec3(0.5, 0.1, 0.0) * flow * 0.35;
  float smoke = fbm(p * 3.0 + vec2(t * 0.1, -t * 0.3)) * uv.y;
  return mix(c, vec3(0.08, 0.05, 0.05), smoke * 0.45);
}

vec3 fxQuantum(vec2 uv, vec3 base, float t) {
  float slice = floor(t * 7.0);
  // reality tears into shifting blocks
  vec2 cell = floor(uv * vec2(9.0, 6.0));
  float h = hash(cell + slice);
  vec2 off = (vec2(hash(cell + slice + 3.1), hash(cell + slice + 7.7)) - 0.5)
             * 0.12 * step(0.55, h);
  // chromatic split
  float shift = 0.010 * step(0.4, hash1(slice + 0.5));
  vec3 c;
  c.r = video(uv + off + vec2(shift, 0.0)).r;
  c.g = video(uv + off).g;
  c.b = video(uv + off - vec2(shift, 0.0)).b;
  // timeline flicker: blend with past + inverted ghosts
  if (hash1(slice + 9.0) > 0.75) c = mix(c, 1.0 - pastA(uv), 0.5);
  else if (hash1(slice + 4.0) > 0.7) c = mix(c, pastB(uv + off), 0.5);
  // evolving hue drift
  c = mix(c, c * (0.5 + hue(fract(t * 0.10 + h))), 0.35);
  // scan tear
  float tear = step(0.985, hash(vec2(floor(uv.y * 160.0), slice)));
  c += vec3(0.4, 1.0, 1.0) * tear;
  return c;
}

vec3 fxCrystal(vec2 uv, vec3 base, float t) {
  vec2 p = uv * vec2(uRes.x / uRes.y, 1.0) * 9.0;
  vec2 id = floor(p);
  // voronoi facets
  float best = 9.0; vec2 bestPt = vec2(0.0); vec2 bestId = vec2(0.0);
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 g = id + vec2(float(x), float(y));
    vec2 pt = g + vec2(hash(g), hash(g + 5.2));
    float d = length(pt - p);
    if (d < best) { best = d; bestPt = pt; bestId = g; }
  }
  float fh = hash(bestId);
  vec2 facetUv = uv + (bestPt / 9.0 * vec2(uRes.y / uRes.x, 1.0) - uv) * 0.55;   // refract toward facet center
  vec3 c = video(facetUv + (fh - 0.5) * 0.02);
  // rainbow fresnel per facet
  vec3 tint = 0.6 + 0.4 * hue(fract(fh + t * 0.05));
  c = mix(c, c * tint + tint * 0.22, 0.65);
  // bright facet edges
  float edge = smoothstep(0.12, 0.0, abs(best - 0.5) - 0.32);
  float spark = pow(max(0.0, sin(fh * 40.0 + t * 2.0)), 24.0);
  return c * (0.8 + 0.5 * fh) + vec3(0.8, 0.95, 1.0) * (edge * 0.35 + spark * 0.8);
}

vec3 fxFrozen(vec2 uv, vec3 base, float t) {
  vec3 c = base;
  float g = lum(c);
  c = mix(vec3(g), c, 0.35) * vec3(0.75, 0.9, 1.15);          // cold desaturation
  vec2 p = uv * vec2(uRes.x / uRes.y, 1.0);
  float frost = fbm(p * 9.0) * fbm(p * 23.0 + 5.0);
  float m = mask(uv);
  float rim = 1.0 - smoothstep(0.0, 0.8, m);                   // frost creeps from edges
  float ice = smoothstep(0.25, 0.6, frost * (0.65 + rim));
  c = mix(c, vec3(0.85, 0.93, 1.0), ice * 0.55);
  float sparkle = stars(p * 2.0, 140.0, t * 2.0);
  c += vec3(0.9, 0.97, 1.0) * sparkle * 0.5;
  float mist = fbm(p * 3.0 + vec2(t * 0.05, t * 0.02));
  return mix(c, vec3(0.8, 0.9, 1.0), mist * 0.18);
}

vec3 fxDream(vec2 uv, vec3 base, float t) {
  // syrupy warp
  vec2 w = uv + vec2(sin(uv.y * 6.0 + t * 0.6), cos(uv.x * 6.0 + t * 0.5)) * 0.012;
  vec3 c = vec3(0.0);
  float total = 0.0;                                          // soft dreamy blur
  for (int i = 0; i < 5; i++) {
    float fi = float(i);
    vec2 o = vec2(sin(fi * 2.4 + t * 0.3), cos(fi * 2.4)) * 0.006 * fi;
    float wgt = 1.0 / (1.0 + fi);
    c += video(w + o) * wgt; total += wgt;
  }
  c /= total;
  c = pow(c, vec3(0.85));                                     // lifted shadows
  vec3 pastel = 0.5 + 0.5 * hue(fract(uv.x * 0.3 + uv.y * 0.2 + t * 0.02));
  c = mix(c, c * pastel + pastel * 0.15, 0.35);
  float glow = fbm(uv * 4.0 + t * 0.1);
  return c + vec3(1.0, 0.8, 0.9) * glow * glow * 0.22;
}

vec3 fxPixel(vec2 uv, vec3 base, float t) {
  float px = 42.0;
  vec2 cell = floor(uv * vec2(px * uRes.x / uRes.y, px));
  // block-by-block conversion wave
  float reveal = smoothstep(0.0, 8.0, t - hash(cell) * 6.0);
  vec2 quv = (cell + 0.5) / vec2(px * uRes.x / uRes.y, px);
  vec3 c = video(quv);
  c = floor(c * 5.0 + 0.5) / 5.0;                             // palette crush
  c = pow(c, vec3(0.9)) * 1.1;
  float gridline = step(0.92, fract(uv.x * px * uRes.x / uRes.y)) + step(0.92, fract(uv.y * px));
  c *= 1.0 - gridline * 0.15;
  return mix(base, c, reveal);
}

vec3 fxVoid(vec2 uv, vec3 base, float t) {
  vec2 p = uv * vec2(uRes.x / uRes.y, 1.0);
  vec3 c = base * 0.03;                                       // near-total darkness
  // glowing energy filaments
  float f1 = abs(fbm(p * 3.0 + t * 0.10) - 0.5);
  float f2 = abs(fbm(p * 5.0 - t * 0.07 + 30.0) - 0.5);
  float lines = smoothstep(0.045, 0.0, f1) + smoothstep(0.03, 0.0, f2) * 0.7;
  c += vec3(0.2, 0.9, 1.0) * lines * (0.6 + 0.4 * sin(t * 2.0 + uv.x * 10.0));
  // stars slowly being born
  float born = clamp(t * 0.08, 0.0, 1.0);
  c += vec3(stars(p, 70.0, t)) * born;
  return c;
}

// ================= GRAVITY =================

vec3 fxBlackhole(vec2 uv, vec3 base, float t) {
  vec2 d = uv - uCenter; d.x *= uRes.x / uRes.y;
  float r = max(length(d), 1e-4);
  // gravitational lensing: pull sampled rays toward the singularity
  float bend = 0.045 / (r + 0.08);
  vec2 lensed = uv - normalize(uv - uCenter) * bend * 0.5;
  // frame dragging: swirl
  float ang = bend * 2.2;
  vec2 rel = lensed - uCenter;
  lensed = uCenter + vec2(rel.x * cos(ang) - rel.y * sin(ang), rel.x * sin(ang) + rel.y * cos(ang));
  vec3 c = video(lensed);
  float horizon = smoothstep(0.075, 0.045, r);                // event horizon
  float ring = smoothstep(0.02, 0.0, abs(r - 0.085)) * (0.8 + 0.2 * sin(t * 6.0));
  float disk = smoothstep(0.05, 0.0, abs(r - 0.13 - 0.015 * sin(atan(d.y, d.x) * 2.0 + t)));
  c = mix(c, vec3(0.0), horizon);
  c += vec3(1.0, 0.75, 0.35) * ring * 1.6;
  c += vec3(0.9, 0.5, 0.2) * disk * 0.5;
  return c;
}

vec3 fxZeroG(vec2 uv, vec3 base, float t) {
  // everything gently levitates: rising wavy displacement
  float lift = t * 0.01;
  vec2 w = uv + vec2(sin(uv.y * 10.0 + t) * 0.004, -0.5 * lift * (0.5 + 0.5 * noise(uv * 5.0)));
  vec3 c = video(w);
  c = mix(c, c * vec3(0.9, 0.97, 1.1) + vec3(0.02, 0.04, 0.08), 0.5);
  float mote = stars(uv * vec2(uRes.x / uRes.y, 1.0) + vec2(0.0, -t * 0.05), 50.0, t);
  return c + vec3(0.6, 0.85, 1.0) * mote * 0.6;
}

vec3 fxCrush(vec2 uv, vec3 base, float t) {
  // gravity ×10: reality smears and sags downward in pulsing waves
  float pulse = 0.5 + 0.5 * sin(t * 2.2);
  float sag = (uv.y) * 0.05 * (0.6 + pulse * 0.7);
  vec3 c = vec3(0.0);
  for (int i = 0; i < 6; i++) {                                // vertical motion smear
    c += video(uv + vec2(0.0, sag * float(i) / 6.0));
  }
  c /= 6.0;
  c *= vec3(1.0, 0.92, 0.85) * (1.0 - 0.25 * pulse);
  float wave = sin(uv.y * 40.0 - t * 8.0);
  return c * (0.9 + 0.1 * wave);
}

// ================= SPACE WARPS =================

vec3 fxMirror(vec2 uv, vec3 base, float t) {
  vec2 d = uv - uCenter;
  vec2 muv = uCenter + vec2(-d.x, d.y);                        // mirrored world
  vec3 c = video(muv);
  float seam = smoothstep(0.01, 0.0, abs(d.x));
  return c + vec3(0.5, 0.9, 1.0) * seam * (0.5 + 0.5 * sin(t * 4.0));
}

vec3 fxTwist(vec2 uv, vec3 base, float t) {
  vec2 d = uv - uCenter; d.x *= uRes.x / uRes.y;
  float r = length(d);
  float ang = (1.0 - smoothstep(0.0, 0.45, r)) * (2.6 * sin(t * 0.7));
  vec2 rel = uv - uCenter;
  vec2 tuv = uCenter + vec2(rel.x * cos(ang) - rel.y * sin(ang), rel.x * sin(ang) + rel.y * cos(ang));
  vec3 c = video(tuv);
  return c + vec3(0.3, 0.8, 1.0) * abs(sin(ang * 3.0)) * 0.08;
}

vec3 fxTunnel(vec2 uv, vec3 base, float t) {
  vec2 d = uv - uCenter; d.x *= uRes.x / uRes.y;
  float r = max(length(d), 1e-3), a = atan(d.y, d.x);
  // infinite recursive tunnel
  float depth = fract(0.15 / r + t * 0.25);
  vec2 tuv = uCenter + normalize(d) * mix(0.02, 0.4, depth);
  vec3 c = video(tuv) * (0.3 + 0.7 * depth);
  float ringGlow = pow(1.0 - abs(2.0 * fract(0.15 / r + t * 0.25) - 1.0), 6.0);
  c += hue(fract(depth + a / 6.283)) * ringGlow * 0.5;
  return c;
}

// ================= MATERIALS =================

vec3 fxGold(vec2 uv, vec3 base, float t) {
  float l = lum(base);
  vec3 gold = mix(vec3(0.35, 0.16, 0.02), vec3(1.0, 0.78, 0.25), pow(l, 0.7));
  gold += vec3(1.0, 0.9, 0.6) * pow(l, 6.0) * 1.6;             // specular bloom
  float glint = stars(uv * vec2(uRes.x / uRes.y, 1.0), 90.0, t * 1.5);
  return gold + vec3(1.0, 0.95, 0.7) * glint * pow(l, 2.0);
}

vec3 fxGlass(vec2 uv, vec3 base, float t) {
  vec2 p = uv * 14.0;
  vec2 n = vec2(noise(p + t * 0.2), noise(p + 40.0 - t * 0.2)) - 0.5;   // pseudo normal
  vec3 c = video(uv + n * 0.035);
  float fres = pow(1.0 - mask(uv), 1.5);                        // bright rim toward edges
  c = mix(c, c * vec3(0.9, 1.0, 1.05), 0.6) + vec3(0.7, 0.9, 1.0) * fres * 0.45;
  float streak = pow(max(0.0, sin((uv.x + uv.y) * 14.0 + t * 0.5)), 30.0);
  return c + vec3(1.0) * streak * 0.4;
}

vec3 fxPlasma(vec2 uv, vec3 base, float t) {
  vec2 p = uv * vec2(uRes.x / uRes.y, 1.0);
  float e1 = abs(fbm(p * 4.0 + t * 0.5) - 0.5);
  float e2 = abs(fbm(p * 7.0 - t * 0.4 + 9.0) - 0.5);
  float arc = smoothstep(0.05, 0.0, e1) + smoothstep(0.035, 0.0, e2);
  vec3 body = mix(vec3(0.5, 0.1, 1.0), vec3(0.1, 0.9, 1.0), fbm(p * 3.0 + t * 0.3));
  vec3 c = base * 0.35 + body * lum(base) * 1.2;
  return c + vec3(0.7, 0.9, 1.0) * arc * (0.8 + 0.4 * sin(t * 30.0));
}

// ================= TIME =================

vec3 fxFreeze(vec2 uv, vec3 base, float t) {
  vec3 c = frozen(uv);
  float shimmer = noise(uv * 200.0 + t * 2.0) * 0.05;           // faint temporal shimmer
  return c * vec3(0.96, 1.0, 1.05) + shimmer;
}

vec3 fxEcho(vec2 uv, vec3 base, float t) {
  vec3 now = base;
  vec3 g1 = pastA(uv + vec2(0.004, 0.0));
  vec3 g2 = pastB(uv - vec2(0.004, 0.0));
  vec3 c = now * 0.55 + g1 * vec3(0.2, 0.9, 1.0) * 0.45 + g2 * vec3(1.0, 0.3, 0.8) * 0.35;
  return c;
}

// ================= MAIN =================
void main() {
  vec2 uv = vUv;
  float m = mask(uv);
  vec3 base = video(uv);
  vec3 col = base;

  if (m > 0.003 && uMode > 0) {
    vec3 fx = base;
    float t = uTime;
    if      (uMode == 1)  fx = fxCosmic(uv, base, t);
    else if (uMode == 2)  fx = fxCyberpunk(uv, base, t);
    else if (uMode == 3)  fx = fxUnderwater(uv, base, t);
    else if (uMode == 4)  fx = fxLava(uv, base, t);
    else if (uMode == 5)  fx = fxQuantum(uv, base, t);
    else if (uMode == 6)  fx = fxCrystal(uv, base, t);
    else if (uMode == 7)  fx = fxFrozen(uv, base, t);
    else if (uMode == 8)  fx = fxDream(uv, base, t);
    else if (uMode == 9)  fx = fxPixel(uv, base, t);
    else if (uMode == 10) fx = fxVoid(uv, base, t);
    else if (uMode == 11) fx = fxBlackhole(uv, base, t);
    else if (uMode == 12) fx = fxZeroG(uv, base, t);
    else if (uMode == 13) fx = fxCrush(uv, base, t);
    else if (uMode == 14) fx = fxFreeze(uv, base, t);
    else if (uMode == 15) fx = pastA(uv) * vec3(0.9, 0.97, 1.08);          // slow-mo
    else if (uMode == 16) fx = pastA(uv) * vec3(1.08, 0.95, 0.9);          // reverse
    else if (uMode == 17) fx = fxEcho(uv, base, t);
    else if (uMode == 18) fx = fxGold(uv, base, t);
    else if (uMode == 19) fx = fxGlass(uv, base, t);
    else if (uMode == 20) fx = fxPlasma(uv, base, t);
    else if (uMode == 21) fx = fxMirror(uv, base, t);
    else if (uMode == 22) fx = fxTwist(uv, base, t);
    else if (uMode == 23) fx = fxTunnel(uv, base, t);
    col = mix(base, fx, smoothstep(0.0, 0.85, m));
  }

  // holographic edge: glow band along the soft mask boundary
  float band = m * (1.0 - m) * 4.0;
  band = pow(band, 1.6);
  float pulse = 0.72 + 0.28 * sin(uTime * 3.2);
  vec3 edgeCol = mix(vec3(0.29, 0.95, 1.0), vec3(1.0, 0.31, 0.85), 0.5 + 0.5 * sin(uTime * 0.9));
  col += edgeCol * band * pulse * 1.5;

  // subtle cinematic grade on everything
  col = pow(col, vec3(0.98));
  float grain = (hash(uv * uRes + fract(uTime) * 100.0) - 0.5) * 0.03;
  col += grain;
  outColor = vec4(col, 1.0);
}`;
