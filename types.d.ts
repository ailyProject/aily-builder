// 全局类型声明文件
// 解决tree-sitter相关模块的类型问题

declare module 'tree-sitter' {
  export interface SyntaxNode {
    type: string;
    text: string;
    childCount: number;
    child(index: number): SyntaxNode | null;
    children: SyntaxNode[];
    startPosition: { row: number; column: number };
    endPosition: { row: number; column: number };
  }

  export interface Tree {
    rootNode: SyntaxNode;
  }

  export interface Language {
    // Language interface
  }

  export default class Parser {
    setLanguage(language: Language): void;
    parse(input: string): Tree;
  }
}

declare module 'tree-sitter-cpp' {
  import { Language } from 'tree-sitter';
  const Cpp: Language;
  export default Cpp;
}

declare module 'ora' {
  interface Options {
    text?: string;
    color?: string;
    spinner?: string;
  }
  
  interface Ora {
    start(): Ora;
    stop(): Ora;
    succeed(text?: string): Ora;
    fail(text?: string): Ora;
    warn(text?: string): Ora;
    info(text?: string): Ora;
    text: string;
  }
  
  function ora(options?: string | Options): Ora;
  export default ora;
}
