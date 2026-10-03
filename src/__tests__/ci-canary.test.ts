// Deliberately failing: proves CI goes red. Reverted right after.
it('fails on purpose', () => {
  expect(1).toBe(2);
});
