/**
 * modalGate — the one shared "is a modal open?" signal.
 *
 * Why an aria-modal DOM probe (and not a store flag set by each modal
 * component): every modal surface in this codebase already declares itself
 * with `aria-modal="true"` — AlertDialog (including the global alert),
 * LinkDialog, RecoveryCodesDialog, AppPermissionDialog, QuickStartWizard,
 * the DeveloperStudio scaffold modal, the AgentChat rename dialog —
 * portals included, because the walk starts at the document root. So any
 * dialog that follows the same ARIA pattern is gated for free, with no
 * per-component registration to forget and nothing to keep in sync.
 * Surfaces that are deliberately NOT modal keep working: the `.estheme`
 * preview banner is `role="status"` (the desktop stays interactive under
 * it by design), so it does not match.
 *
 * Implemented as a plain tree walk rather than document.querySelector so
 * the same code runs under the repo's node-env test DOM (windowTestDom),
 * which does not implement selector APIs. The walk only runs while a
 * document exists (SSR/import safety) and stops at the first match.
 */

const ELEMENT_NODE = 1;
const MODAL_ATTRIBUTE = 'aria-modal';
/** Only the literal "true" marks a dialog as modal (WAI-ARIA; anything else doesn't gate). */
const MODAL_ATTRIBUTE_VALUE = 'true';

/** True when any `aria-modal="true"` dialog is currently in the document. */
export function isModalOpen(): boolean {
  if (typeof document === 'undefined') return false;
  return subtreeHasModal(document.documentElement);
}

function subtreeHasModal(node: Node): boolean {
  if (node.nodeType === ELEMENT_NODE && (node as Element).getAttribute(MODAL_ATTRIBUTE) === MODAL_ATTRIBUTE_VALUE) {
    return true;
  }
  const children = node.childNodes;
  for (let i = 0; i < children.length; i += 1) {
    if (subtreeHasModal(children[i])) return true;
  }
  return false;
}
