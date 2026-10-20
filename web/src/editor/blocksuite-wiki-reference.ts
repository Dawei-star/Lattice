import type { BlockModel, Text } from '@blocksuite/store';

import {
  BlockComponent,
  BlockViewExtension,
  FlavourExtension,
  type ExtensionType,
} from '@blocksuite/block-std';
import { defineBlockSchema } from '@blocksuite/store';
import { html } from 'lit';
import { literal } from 'lit/static-html.js';

export const LATTICE_WIKI_REFERENCE_FLAVOUR = 'affine:embed-lattice-wiki-reference';

export interface LatticeWikiReferenceProps {
  text: Text;
}

export const LatticeWikiReferenceBlockSchema = defineBlockSchema({
  flavour: LATTICE_WIKI_REFERENCE_FLAVOUR,
  props: internal => ({
    text: internal.Text(),
  }) as LatticeWikiReferenceProps,
  metadata: {
    version: 1,
    role: 'content',
    parent: ['affine:note'],
  },
});

type LatticeWikiReferenceModel = BlockModel<LatticeWikiReferenceProps> & LatticeWikiReferenceProps & {
  flavour: typeof LATTICE_WIKI_REFERENCE_FLAVOUR;
};

class LatticeWikiReferenceBlockComponent extends BlockComponent<LatticeWikiReferenceModel> {
  override renderBlock() {
    return html`
      <div class="lattice-wiki-reference-block" data-lattice-wiki-native="true">
        <span class="lattice-wiki-reference-block__source">${this.model.text.toString()}</span>
      </div>
    `;
  }
}

const ELEMENT_NAME = 'lattice-wiki-reference-block';
if (!customElements.get(ELEMENT_NAME)) {
  customElements.define(ELEMENT_NAME, LatticeWikiReferenceBlockComponent);
}

export const LatticeWikiReferenceBlockSpec: ExtensionType[] = [
  FlavourExtension(LATTICE_WIKI_REFERENCE_FLAVOUR),
  BlockViewExtension(LATTICE_WIKI_REFERENCE_FLAVOUR, literal`lattice-wiki-reference-block`),
];

export function isLatticeWikiReferenceBlock(block: { flavour?: string }): boolean {
  return block.flavour === LATTICE_WIKI_REFERENCE_FLAVOUR;
}

declare global {
  namespace BlockSuite {
    interface BlockModels {
      'affine:embed-lattice-wiki-reference': LatticeWikiReferenceModel;
    }
  }
}
