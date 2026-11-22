import type { ElementDefinition, StructureDefinition } from './types.js';

export interface ElementNode {
  /** Last path segment, e.g. `contact` or `value[x]`. */
  name: string;
  /** Full path, e.g. `Patient.contact.name`. */
  path: string;
  element: ElementDefinition;
  children: ElementNode[];
}

export interface ElementTree {
  root: ElementNode;
  /** Every node, keyed by path. */
  byPath: Map<string, ElementNode>;
}

/**
 * Turns a StructureDefinition's flat snapshot element list into a tree, using
 * the element paths. Slices are skipped: base definitions don't use them, and
 * profile support will handle them separately.
 */
export function buildElementTree(sd: StructureDefinition): ElementTree {
  const elements = sd.snapshot?.element;
  if (!elements?.length) {
    throw new Error(`StructureDefinition ${sd.url} has no snapshot`);
  }
  const [first, ...rest] = elements;
  const root: ElementNode = { name: first!.path, path: first!.path, element: first!, children: [] };
  const byPath = new Map<string, ElementNode>([[root.path, root]]);

  for (const element of rest) {
    if (element.sliceName) continue;
    const parentPath = element.path.slice(0, element.path.lastIndexOf('.'));
    const parent = byPath.get(parentPath);
    if (!parent) {
      throw new Error(`${sd.url}: element ${element.path} has no parent ${parentPath}`);
    }
    const node: ElementNode = {
      name: element.path.slice(parentPath.length + 1),
      path: element.path,
      element,
      children: [],
    };
    parent.children.push(node);
    byPath.set(node.path, node);
  }
  return { root, byPath };
}
