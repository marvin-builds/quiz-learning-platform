import { releaseImage } from '@/lib/pick-image.web';

// The web picker hands out object URLs (blob:), which keep their file in
// memory until revoked; releasing one revokes it (#83, review). Other URIs
// (a stored image's URL) are not the picker's to revoke.

const revoke = jest.fn();
const realRevoke = URL.revokeObjectURL;
beforeAll(() => {
  URL.revokeObjectURL = revoke;
});
afterAll(() => {
  URL.revokeObjectURL = realRevoke;
});

it('revokes an object URL', () => {
  releaseImage('blob:http://localhost:8081/0f6c');
  expect(revoke).toHaveBeenCalledWith('blob:http://localhost:8081/0f6c');
});

it('leaves any other URI alone', () => {
  revoke.mockClear();
  releaseImage('http://127.0.0.1:54321/storage/v1/object/public/quiz-images/a.png');
  expect(revoke).not.toHaveBeenCalled();
});
