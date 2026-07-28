import { useMemo, useRef } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import * as THREE from "three";

/* Orbiting particle constellation + wireframe core.
   Pure ambience for the hero — pointer-events none, ~900 points. */

function ParticleShell({ count = 900 }: { count?: number }) {
  const ref = useRef<THREE.Points>(null);
  const positions = useMemo(() => {
    const arr = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      // Random points in a spherical shell 1.6..2.6
      const r = 1.6 + Math.random();
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      arr[i * 3] = r * Math.sin(phi) * Math.cos(theta);
      arr[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
      arr[i * 3 + 2] = r * Math.cos(phi);
    }
    return arr;
  }, [count]);

  useFrame((state, delta) => {
    if (!ref.current) return;
    ref.current.rotation.y += delta * 0.05;
    ref.current.rotation.x = Math.sin(state.clock.elapsedTime * 0.12) * 0.12;
  });

  return (
    <points ref={ref}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
      </bufferGeometry>
      <pointsMaterial size={0.02} color="#67e8f9" transparent opacity={0.75} sizeAttenuation depthWrite={false} />
    </points>
  );
}

function Core() {
  const ref = useRef<THREE.Mesh>(null);
  useFrame((state, delta) => {
    if (!ref.current) return;
    ref.current.rotation.y += delta * 0.16;
    ref.current.rotation.z += delta * 0.05;
    const s = 1 + Math.sin(state.clock.elapsedTime * 0.8) * 0.03;
    ref.current.scale.setScalar(s);
  });
  return (
    <mesh ref={ref}>
      <icosahedronGeometry args={[1.05, 1]} />
      <meshBasicMaterial color="#a78bfa" wireframe transparent opacity={0.5} />
    </mesh>
  );
}

function OrbitalRing({ radius, tilt, speed, color }: { radius: number; tilt: number; speed: number; color: string }) {
  const ref = useRef<THREE.Group>(null);
  useFrame((_, delta) => {
    if (ref.current) ref.current.rotation.z += delta * speed;
  });
  return (
    <group rotation={[tilt, 0.4, 0]}>
      <group ref={ref}>
        <mesh>
          <torusGeometry args={[radius, 0.004, 8, 128]} />
          <meshBasicMaterial color={color} transparent opacity={0.35} />
        </mesh>
      </group>
    </group>
  );
}

export default function Scene3D() {
  return (
    <Canvas
      dpr={[1, 1.8]}
      camera={{ position: [0, 0.4, 4.6], fov: 42 }}
      gl={{ antialias: true, alpha: true, powerPreference: "low-power" }}
      style={{ background: "transparent" }}
    >
      <Core />
      <ParticleShell />
      <OrbitalRing radius={1.9} tilt={1.15} speed={0.10} color="#67e8f9" />
      <OrbitalRing radius={2.25} tilt={1.35} speed={-0.07} color="#a78bfa" />
    </Canvas>
  );
}
