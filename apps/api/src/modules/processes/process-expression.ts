// ============================================================
// Ф5 — безопасный вычислитель выражений для {{ ... }} (n8n#5).
// НЕ JavaScript и НЕ eval: тонкий рекурсивный парсер в AST + вычисление по белому списку
// (арифметика, сравнения, логика, тернарник, доступ к полям/индексам, немного функций).
// Доступ к данным — ТОЛЬКО own-property (прототип не достаётся). Ошибка парса/вычисления →
// исключение (renderTemplate ловит и подставляет ''). Бенчмарк-модель: Google CEL / формулы
// Salesforce — мощь выражений без поверхности выполнения произвольного кода.
// ============================================================

type Tok = { t: 'num' | 'str' | 'id' | 'op'; v: string };

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  const two = ['==', '!=', '<=', '>=', '&&', '||'];
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
    if (c >= '0' && c <= '9') {
      let j = i + 1;
      while (j < src.length && ((src[j] >= '0' && src[j] <= '9') || src[j] === '.')) j++;
      toks.push({ t: 'num', v: src.slice(i, j) });
      i = j;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      let s = '';
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\\' && j + 1 < src.length) { s += src[j + 1]; j += 2; } else { s += src[j]; j++; }
      }
      if (j >= src.length) throw new Error('незакрытая строка');
      toks.push({ t: 'str', v: s });
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
      toks.push({ t: 'id', v: src.slice(i, j) });
      i = j;
      continue;
    }
    const pair = src.slice(i, i + 2);
    if (two.includes(pair)) { toks.push({ t: 'op', v: pair }); i += 2; continue; }
    if ('+-*/%!<>()[].,?:'.includes(c)) { toks.push({ t: 'op', v: c }); i++; continue; }
    throw new Error(`недопустимый символ «${c}»`);
  }
  return toks;
}

// --- AST-узлы как замыкания-вычислители (парсер сразу строит eval-функции) ---
type Ctx = Record<string, unknown>;
type Ev = (ctx: Ctx) => unknown;

const FUNCS: Record<string, (...a: unknown[]) => unknown> = {
  len: (x) => (Array.isArray(x) || typeof x === 'string' ? (x as { length: number }).length : 0),
  upper: (s) => String(s ?? '').toUpperCase(),
  lower: (s) => String(s ?? '').toLowerCase(),
  trim: (s) => String(s ?? '').trim(),
  round: (n, d) => { const f = 10 ** (Number(d) || 0); return Math.round(Number(n) * f) / f; },
  number: (x) => Number(x),
  string: (x) => (x === null || x === undefined ? '' : typeof x === 'object' ? JSON.stringify(x) : String(x)),
  contains: (s, sub) => String(s ?? '').includes(String(sub ?? '')),
  default: (a, b) => (a === null || a === undefined || a === '' ? b : a),
};

/** own-property доступ (без прототипа) — как в renderTemplate. */
function member(obj: unknown, key: string | number): unknown {
  if (obj === null || obj === undefined) return undefined;
  if (Array.isArray(obj)) return typeof key === 'number' ? obj[key] : undefined;
  if (typeof obj === 'object') {
    return Object.prototype.hasOwnProperty.call(obj, key) ? (obj as Record<string, unknown>)[key as string] : undefined;
  }
  return undefined;
}

function num(x: unknown): number {
  return typeof x === 'number' ? x : Number(x);
}
function truthy(x: unknown): boolean {
  if (typeof x === 'boolean') return x;
  if (x === null || x === undefined || x === '' || x === 0) return false;
  return true;
}

class Parser {
  private p = 0;
  constructor(private toks: Tok[]) {}
  private peek(): Tok | undefined { return this.toks[this.p]; }
  private eat(v?: string): Tok {
    const t = this.toks[this.p];
    if (!t || (v !== undefined && t.v !== v)) throw new Error(`ожидалось «${v ?? '?'}»`);
    this.p++;
    return t;
  }
  private isOp(v: string): boolean { const t = this.peek(); return !!t && t.t === 'op' && t.v === v; }

  parse(): Ev {
    const e = this.ternary();
    if (this.p !== this.toks.length) throw new Error('лишние символы в выражении');
    return e;
  }
  private ternary(): Ev {
    const c = this.or();
    if (this.isOp('?')) {
      this.eat('?');
      const a = this.ternary();
      this.eat(':');
      const b = this.ternary();
      return (ctx) => (truthy(c(ctx)) ? a(ctx) : b(ctx));
    }
    return c;
  }
  private or(): Ev {
    let l = this.and();
    while (this.isOp('||')) { this.eat('||'); const r = this.and(); const ll = l; l = (ctx) => (truthy(ll(ctx)) ? ll(ctx) : r(ctx)); }
    return l;
  }
  private and(): Ev {
    let l = this.equality();
    while (this.isOp('&&')) { this.eat('&&'); const r = this.equality(); const ll = l; l = (ctx) => (truthy(ll(ctx)) ? r(ctx) : ll(ctx)); }
    return l;
  }
  private equality(): Ev {
    let l = this.comparison();
    while (this.isOp('==') || this.isOp('!=')) {
      const op = this.eat().v; const r = this.comparison(); const ll = l;
      l = (ctx) => { const a = ll(ctx), b = r(ctx); return op === '==' ? a === b || String(a) === String(b) : !(a === b || String(a) === String(b)); };
    }
    return l;
  }
  private comparison(): Ev {
    let l = this.additive();
    while (this.isOp('<') || this.isOp('>') || this.isOp('<=') || this.isOp('>=')) {
      const op = this.eat().v; const r = this.additive(); const ll = l;
      l = (ctx) => { const a = num(ll(ctx)), b = num(r(ctx)); return op === '<' ? a < b : op === '>' ? a > b : op === '<=' ? a <= b : a >= b; };
    }
    return l;
  }
  private additive(): Ev {
    let l = this.multiplicative();
    while (this.isOp('+') || this.isOp('-')) {
      const op = this.eat().v; const r = this.multiplicative(); const ll = l;
      l = (ctx) => {
        const a = ll(ctx), b = r(ctx);
        if (op === '+' && (typeof a === 'string' || typeof b === 'string')) return String(a ?? '') + String(b ?? '');
        return op === '+' ? num(a) + num(b) : num(a) - num(b);
      };
    }
    return l;
  }
  private multiplicative(): Ev {
    let l = this.unary();
    while (this.isOp('*') || this.isOp('/') || this.isOp('%')) {
      const op = this.eat().v; const r = this.unary(); const ll = l;
      l = (ctx) => { const a = num(ll(ctx)), b = num(r(ctx)); return op === '*' ? a * b : op === '/' ? a / b : a % b; };
    }
    return l;
  }
  private unary(): Ev {
    if (this.isOp('!')) { this.eat('!'); const e = this.unary(); return (ctx) => !truthy(e(ctx)); }
    if (this.isOp('-')) { this.eat('-'); const e = this.unary(); return (ctx) => -num(e(ctx)); }
    return this.postfix();
  }
  private postfix(): Ev {
    let e = this.primary();
    for (;;) {
      if (this.isOp('.')) {
        this.eat('.');
        const name = this.eat().v;
        const prev = e;
        e = (ctx) => member(prev(ctx), name);
      } else if (this.isOp('[')) {
        this.eat('[');
        const idxE = this.ternary();
        this.eat(']');
        const prev = e;
        e = (ctx) => { const k = idxE(ctx); return member(prev(ctx), typeof k === 'number' ? k : String(k)); };
      } else break;
    }
    return e;
  }
  private primary(): Ev {
    const t = this.peek();
    if (!t) throw new Error('неожиданный конец выражения');
    if (t.t === 'num') { this.p++; const n = Number(t.v); return () => n; }
    if (t.t === 'str') { this.p++; const s = t.v; return () => s; }
    if (this.isOp('(')) { this.eat('('); const e = this.ternary(); this.eat(')'); return e; }
    if (t.t === 'id') {
      this.p++;
      const name = t.v;
      if (name === 'true') return () => true;
      if (name === 'false') return () => false;
      if (name === 'null') return () => null;
      // Вызов функции из белого списка: name(args...)
      if (this.isOp('(')) {
        this.eat('(');
        const args: Ev[] = [];
        if (!this.isOp(')')) { args.push(this.ternary()); while (this.isOp(',')) { this.eat(','); args.push(this.ternary()); } }
        this.eat(')');
        const fn = FUNCS[name];
        if (!fn) throw new Error(`неизвестная функция «${name}»`);
        return (ctx) => fn(...args.map((a) => a(ctx)));
      }
      // Идентификатор — корень контекста (form/steps/item/initiator/instance...).
      return (ctx) => member(ctx, name);
    }
    throw new Error('неверное выражение');
  }
}

/** Вычислить выражение против контекста. Бросает при ошибке парса/вычисления. */
export function evalExpression(src: string, ctx: Ctx): unknown {
  const ev = new Parser(tokenize(src)).parse();
  return ev(ctx);
}
