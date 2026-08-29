import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import SpecProposal from '../components/SpecProposal';

const mongo = {
  id: 'mongo',
  image: 'mongo:7',
  ports: [{ name: 'mongo', port: 27017 }],
  volumes: [{ path: '/data/db', size: '10Gi' }],
  env: [
    { name: 'MONGO_INITDB_ROOT_PASSWORD', generate: 'password' },
    { name: 'MONGO_INITDB_DATABASE', value: 'cache' },
  ],
  resources: { limits: { memory: '1Gi', cpu: '1000m' } },
};

describe('what a reviewer is shown', () => {
  it('names what will actually run', () => {
    render(<SpecProposal spec={mongo} onAccept={vi.fn()} />);
    expect(screen.getByText('mongo')).toBeInTheDocument();
    expect(screen.getByText('mongo:7')).toBeInTheDocument();
    expect(screen.getByText(/27017 \(mongo\)/)).toBeInTheDocument();
    expect(screen.getByText(/10Gi at \/data\/db/)).toBeInTheDocument();
    expect(screen.getByText(/1Gi \/ 1000m/)).toBeInTheDocument();
  });

  it('names the credential that will be generated, without a value', () => {
    render(<SpecProposal spec={mongo} onAccept={vi.fn()} />);
    expect(screen.getByText(/MONGO_INITDB_ROOT_PASSWORD — generated on deploy/)).toBeInTheDocument();
    expect(screen.queryByText(/MONGO_INITDB_DATABASE/)).not.toBeInTheDocument();
  });

  it('says accepting is not deploying', () => {
    render(<SpecProposal spec={mongo} onAccept={vi.fn()} />);
    expect(screen.getByText(/Nothing is deployed by adding it/)).toBeInTheDocument();
  });

  it('renders a spec with no disk or secrets', () => {
    render(<SpecProposal spec={{ id: 'tei', image: 'tei:1', ports: [{ name: 'http', port: 80 }] }} onAccept={vi.fn()} />);
    expect(screen.queryByText(/Disk/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Secrets/)).not.toBeInTheDocument();
  });
});

describe('accepting', () => {
  it('calls back once', () => {
    const onAccept = vi.fn();
    render(<SpecProposal spec={mongo} onAccept={onAccept} />);
    fireEvent.click(screen.getByText('Add to the catalogue'));
    expect(onAccept).toHaveBeenCalledTimes(1);
  });

  it('does not offer to add one that is already added', () => {
    render(<SpecProposal spec={mongo} accepted onAccept={vi.fn()} />);
    expect(screen.queryByText('Add to the catalogue')).not.toBeInTheDocument();
    expect(screen.getByText(/mongo can now be deployed/)).toBeInTheDocument();
  });

  it('disables while a request is in flight', () => {
    render(<SpecProposal spec={mongo} pending onAccept={vi.fn()} />);
    expect(screen.getByText('Add to the catalogue')).toBeDisabled();
  });
});
