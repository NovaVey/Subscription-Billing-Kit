import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { AdminGate } from '../../src/components/AdminGate';
import { getAdminKey } from '../../src/lib/adminKey';

beforeEach(() => {
  sessionStorage.clear();
});

describe('AdminGate blank-key submit guard', () => {
  it('renders the key form (not children) when no key is stored', () => {
    render(
      <AdminGate>
        <div>secret content</div>
      </AdminGate>,
    );
    expect(screen.getByLabelText('Admin key')).toBeInTheDocument();
    expect(screen.queryByText('secret content')).not.toBeInTheDocument();
  });

  it('is a no-op when the form is submitted with an empty or whitespace-only key', async () => {
    const user = userEvent.setup();
    render(
      <AdminGate>
        <div>secret content</div>
      </AdminGate>,
    );

    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(getAdminKey()).toBeNull();
    expect(screen.getByLabelText('Admin key')).toBeInTheDocument();

    await user.type(screen.getByLabelText('Admin key'), '   ');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(getAdminKey()).toBeNull();
    expect(screen.getByLabelText('Admin key')).toBeInTheDocument();
  });

  it('stores the trimmed key and renders children once a real key is submitted', async () => {
    const user = userEvent.setup();
    render(
      <AdminGate>
        <div>secret content</div>
      </AdminGate>,
    );

    await user.type(screen.getByLabelText('Admin key'), '  test-write-key  ');
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    expect(getAdminKey()).toBe('test-write-key');
    expect(screen.getByText('secret content')).toBeInTheDocument();
    expect(screen.queryByLabelText('Admin key')).not.toBeInTheDocument();
  });
});
