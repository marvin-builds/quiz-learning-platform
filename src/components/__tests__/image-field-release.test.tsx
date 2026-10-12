import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { useState } from 'react';

import { ImageField } from '@/components/image-field';
import '@/i18n';
import type { ImageFile } from '@/lib/question-schema';

// A picked file stays in memory as long as its URI is held: on the web an
// object URL of up to 5 MiB that lives until the page closes. The field
// releases a picked file's URI once the form drops it, when it is replaced
// or removed (#83, review). A stored image has no local file to release.

jest.mock('@/lib/pick-image', () => ({
  pickImage: jest.fn(),
  releaseImage: jest.fn(),
}));

jest.mock('@/lib/supabase', () => ({
  supabase: {
    storage: {
      from: () => ({
        getPublicUrl: (path: string) => ({ data: { publicUrl: `http://s/${path}` } }),
      }),
    },
  },
}));

const pickModule = jest.requireMock('@/lib/pick-image') as {
  pickImage: jest.Mock;
  releaseImage: jest.Mock;
};

const LABELS = {
  pick: 'Bild wählen',
  replace: 'Bild ersetzen',
  remove: 'Bild entfernen',
  alt: 'Alternativtext',
  preview: 'Vorschau',
};

function Harness({ initialPath = null }: { initialPath?: string | null }) {
  const [path, setPath] = useState<string | null>(initialPath);
  const [file, setFile] = useState<ImageFile | null>(null);
  return (
    <ImageField
      id="image"
      labels={LABELS}
      path={path}
      file={file}
      alt={null}
      onPicked={(newPath, newFile) => {
        setPath(newPath);
        setFile(newFile);
      }}
      onRemove={() => {
        setPath(null);
        setFile(null);
      }}
      onAltChange={() => {}}
    />
  );
}

const picks = (uri: string) =>
  pickModule.pickImage.mockResolvedValueOnce({ uri, mimeType: 'image/png', size: 1024 });

beforeEach(() => {
  pickModule.pickImage.mockReset();
  pickModule.releaseImage.mockReset();
});

it('releases the replaced file once another one is taken', async () => {
  await render(<Harness />);
  picks('blob:first');
  await fireEvent.press(await screen.findByRole('button', { name: LABELS.pick }));
  picks('blob:second');
  await fireEvent.press(await screen.findByRole('button', { name: LABELS.replace }));

  await waitFor(() => expect(pickModule.releaseImage).toHaveBeenCalledWith('blob:first'));
  expect(pickModule.releaseImage).not.toHaveBeenCalledWith('blob:second');
});

it('releases the picked file when the image is removed', async () => {
  await render(<Harness />);
  picks('blob:first');
  await fireEvent.press(await screen.findByRole('button', { name: LABELS.pick }));
  await fireEvent.press(await screen.findByRole('button', { name: LABELS.remove }));

  expect(pickModule.releaseImage).toHaveBeenCalledWith('blob:first');
});

it('keeps the file when a pick is cancelled', async () => {
  await render(<Harness />);
  picks('blob:first');
  await fireEvent.press(await screen.findByRole('button', { name: LABELS.pick }));
  pickModule.pickImage.mockResolvedValueOnce(null);
  await fireEvent.press(await screen.findByRole('button', { name: LABELS.replace }));

  await waitFor(() => expect(pickModule.pickImage).toHaveBeenCalledTimes(2));
  expect(pickModule.releaseImage).not.toHaveBeenCalled();
});

it('releases nothing for a stored image', async () => {
  await render(<Harness initialPath="30000000-0000-4000-8000-000000000003.png" />);
  await fireEvent.press(await screen.findByRole('button', { name: LABELS.remove }));

  expect(pickModule.releaseImage).not.toHaveBeenCalled();
});
