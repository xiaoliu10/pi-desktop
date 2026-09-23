import PiReplicaApp from './pi/PiReplicaApp';
/**
 * Production entry: the accepted replica UI (PI-Desktop visual baseline)
 * driven by the local pi backend through src/renderer/pi/adapter.ts.
 * The former PiDesktop view stays in the repo for reference but is no
 * longer mounted. Demo preview lives at ?preview=1 (src/renderer/preview).
 */
export default function App() {
  return <PiReplicaApp />;
}
