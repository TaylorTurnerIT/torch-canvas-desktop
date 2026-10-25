  // Evaluate dimension arithmetic without dynamic JavaScript compilation. This
  // also runs inside the variance worker, under the desktop content policy.
  function evalDim(expr, symbols, integer = true) {
    if (expr === '' || expr == null) return null;
    const source = String(expr).trim();
    if (/^-?\d+(\.\d+)?$/.test(source)) return +source;
    if (!/^[\w\s+\-*/().]+$/.test(source)) return null;
    let missing = false;
    const text = source.replace(IDENT, id => {
      const value = symbols && symbols[id];
      if (value != null && value !== '' && Number.isFinite(+value)) return '(' + (+value) + ')';
      missing = true;
      return '0';
    }).replace(/\/\//g, '/');
    if (missing || /\+\+|--/.test(text)) return null;

    let position = 0;
    const skip = () => { while (/\s/.test(text[position] || '') && position < text.length) position++; };
    function expression(minimum = 0) {
      skip();
      let left;
      const first = text[position];
      if (first === '+' || first === '-') {
        position++;
        const operand = expression(30);
        if (operand.exponent) throw new Error('Parenthesize the exponent base');
        left = { value: first === '-' ? -operand.value : operand.value, unary: true };
      } else if (first === '(') {
        position++;
        left = expression();
        skip();
        if (text[position++] !== ')') throw new Error('Unclosed dimension expression');
        left = { value: left.value, unary: false };
      } else {
        const match = text.slice(position).match(/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/);
        if (!match) throw new Error('Expected a dimension number');
        position += match[0].length;
        left = { value: +match[0], unary: false };
      }
      while (true) {
        skip();
        const operator = text.startsWith('**', position) ? '**' : text[position];
        const precedence = { '+': 10, '-': 10, '*': 20, '/': 20, '**': 40 }[operator];
        if (precedence == null || precedence < minimum) break;
        // JavaScript requires parentheses around a unary base of exponentiation.
        if (operator === '**' && left.unary) throw new Error('Parenthesize the exponent base');
        position += operator.length;
        const right = expression(precedence + (operator === '**' ? 0 : 1));
        const a = left.value, b = right.value;
        left = { value: operator === '+' ? a + b : operator === '-' ? a - b : operator === '*' ? a * b : operator === '/' ? a / b : a ** b, unary: false, exponent: operator === '**' };
      }
      return left;
    }
    try {
      const value = expression().value;
      skip();
      return position === text.length && Number.isFinite(value) ? (integer ? Math.floor(value) : value) : null;
    } catch { return null; }
  }
