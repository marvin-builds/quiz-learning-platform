import { configure } from '@testing-library/react-native';

// findBy* and waitFor give up after 1 s by default. Under load (several
// slices testing in parallel, the coverage run in CI) a screen that renders
// in time when idle can take longer, and a test that times out leaves its
// pending work (e.g. a picker call) to the next test (#83, review). 5 s stays
// well below the test timeout and never makes a passing test slower.
configure({ asyncUtilTimeout: 5000 });
