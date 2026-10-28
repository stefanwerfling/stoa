// JSX image text-alternative correctness fixture.
export const Imgs = () => (
  <>
    {/* fine: a non-empty aria-label is a text alternative */}
    <img src="a.png" aria-label="Quarterly sales chart" />
    {/* fine: a non-empty aria-labelledby is conservatively treated as a name */}
    <img src="b.png" aria-labelledby="cap" />
    {/* flagged: no alt, no name */}
    <img src="c.png" />
    {/* flagged: an empty aria-label is not a text alternative */}
    <img src="d.png" aria-label="" />
  </>
);
