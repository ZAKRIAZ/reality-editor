// ============ WebGL2 compositor ============
import { VERT, FRAG } from './shaders.js';

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: false });
    if (!gl) throw new Error('WebGL2 unavailable');
    this.gl = gl;

    this.program = this._link(VERT, FRAG);
    gl.useProgram(this.program);

    // fullscreen quad
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(this.program, 'aPos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    this.u = {};
    for (const name of ['uVideo', 'uMask', 'uFrozen', 'uPastA', 'uPastB',
                        'uTime', 'uMode', 'uRes', 'uCenter', 'uMirror']) {
      this.u[name] = gl.getUniformLocation(this.program, name);
    }

    this.tex = {
      video:  this._makeTex(0),
      mask:   this._makeTex(1),
      frozen: this._makeTex(2),
      pastA:  this._makeTex(3),
      pastB:  this._makeTex(4),
    };
    gl.uniform1i(this.u.uVideo, 0);
    gl.uniform1i(this.u.uMask, 1);
    gl.uniform1i(this.u.uFrozen, 2);
    gl.uniform1i(this.u.uPastA, 3);
    gl.uniform1i(this.u.uPastB, 4);
  }

  _link(vs, fs) {
    const gl = this.gl;
    const compile = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        throw new Error('shader: ' + gl.getShaderInfoLog(s));
      }
      return s;
    };
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      throw new Error('link: ' + gl.getProgramInfoLog(p));
    }
    return p;
  }

  _makeTex(unit) {
    const gl = this.gl;
    const t = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    // 1×1 black placeholder so sampling is always defined
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
                  new Uint8Array([0, 0, 0, 255]));
    return t;
  }

  upload(name, source) {
    const gl = this.gl;
    const unit = { video: 0, mask: 1, frozen: 2, pastA: 3, pastB: 4 }[name];
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, this.tex[name]);
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    } catch (_) { /* video not ready yet */ }
  }

  render({ time, mode, center, mirror }) {
    const gl = this.gl;
    const w = this.canvas.clientWidth * Math.min(devicePixelRatio, 1.5) | 0;
    const h = this.canvas.clientHeight * Math.min(devicePixelRatio, 1.5) | 0;
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w; this.canvas.height = h;
    }
    gl.viewport(0, 0, w, h);
    gl.uniform1f(this.u.uTime, time);
    gl.uniform1i(this.u.uMode, mode);
    gl.uniform2f(this.u.uRes, w, h);
    gl.uniform2f(this.u.uCenter, center[0], center[1]);
    gl.uniform1f(this.u.uMirror, mirror ? 1 : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}
