declare namespace JSX {
  interface Element { readonly rendered?: true }
  interface IntrinsicElements { [name: string]: Record<string, unknown> }
  interface ElementChildrenAttribute { children: unknown }
}
