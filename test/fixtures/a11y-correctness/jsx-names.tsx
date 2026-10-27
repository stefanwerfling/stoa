// JSX accessible-name and focusability correctness fixture (React/TSX).
export const Correctness = () => (
  <>
    {/* flagged: the only content is an aria-hidden child */}
    <button><span aria-hidden="true">Menu</span></button>
    {/* flagged: aria-labelledby present but empty */}
    <button aria-labelledby=""></button>
    {/* flagged: role=presentation is ignored on a focusable button */}
    <button role="presentation"></button>
    {/* fine: aria-label wins over hidden content */}
    <button aria-label="Close"><span aria-hidden="true">x</span></button>
    {/* flagged by aria-hidden-focusable: a contentEditable editing host */}
    <div aria-hidden="true" contentEditable>Edit</div>
  </>
);
