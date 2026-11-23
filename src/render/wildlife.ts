import * as T from 'three';
import { PADS, type Wildlife } from '../sim/wildlife';

const PETALS = [0xf3b34d, 0xed93a5, 0xffedc1];
export class WildlifeView {
  readonly group = new T.Group();
  private bird = new T.Group();
  private head = new T.Group();
  private wings: T.Group[] = [];
  private frog = new T.Group();
  private throat: T.Mesh;
  private grain = new T.Group();
  private petals: T.MeshStandardMaterial[] = [];
  private lilyPads: T.Group[] = [];
  private sphere = new T.SphereGeometry(1, 16, 12);
  private materials = new Map<number, T.MeshStandardMaterial>();

  constructor(scene: T.Scene) {
    scene.add(this.group);
    this.group.add(this.bird, this.frog, this.grain);
    const bird = this.bird, head = this.head;
    bird.add(head);
    this.oval(bird, 0, .18, -.015, .16, .185, .235, 0x8b745b);
    this.oval(bird, 0, .17, .065, .144, .152, .183, 0xd6cbb2);
    head.position.set(0, .33, .105);
    this.oval(head, 0, 0, 0, .136, .139, .135, 0x886e50);
    this.oval(head, 0, -.052, .053, .127, .147, .105, 0xd87b38);
    for (const side of [-1, 1]) {
      this.oval(head, side * .101, .022, .082, .027, .03, .024, 0x221d1a);
      this.oval(head, side * .115, .032, .099, .008, .008, .007, 0xfff2db);
      const wing = new T.Group();
      wing.position.set(side * .125, .245, -.02);
      bird.add(wing);
      this.wings.push(wing);
      this.oval(wing, side * .017, -.04, -.05, .054, .105, .189, 0x71563d).rotation.x = -.25;
      for (let i = 0; i < 3; i++) this.oval(wing, side * .050, -.035 - i * .018, -.09 + i * .021, .014, .016, .115, 0xb69b70);
      this.oval(bird, side * .065, .065, .012, .012, .06, .012, 0x654834);
      this.oval(bird, side * .065, .014, .038, .029, .012, .054, 0x705236);
      this.oval(bird, side * .038, .195, -.244, .049, .029, .16, 0x684d35).rotation.x = .18;
    }
    const beak = new T.Mesh(new T.ConeGeometry(.029, .09, 8), this.material(0x44372b));
    head.add(beak);
    beak.position.set(0, -.006, .156);
    beak.rotation.x = Math.PI / 2;

    const frog = this.frog;
    this.oval(frog, 0, .094, -.025, .163, .102, .215, 0x637e43);
    this.oval(frog, 0, .152, .096, .149, .095, .135, 0x96a45b);
    this.throat = this.oval(frog, 0, .112, .158, .115, .055, .078, 0xe0cf86);
    for (const side of [-1, 1]) {
      this.oval(frog, side * .096, .22, .118, .055, .059, .055, 0x8e9957);
      this.oval(frog, side * .101, .232, .157, .034, .031, .022, 0xdca84e);
      this.oval(frog, side * .104, .234, .174, .026, .009, .008, 0x231f1a);
      this.oval(frog, side * .11, .245, .173, .006, .006, .006, 0xffe6ae);
      this.oval(frog, side * .15, .085, -.088, .075, .066, .141, 0x506f40);
      this.oval(frog, side * .182, .028, -.041, .053, .021, .115, 0x9a9e59);
      this.oval(frog, side * .124, .064, .089, .028, .054, .035, 0x869450);
      this.oval(frog, side * .138, .024, .124, .042, .016, .057, 0xb4aa65);
      for (let i = 0; i < 4; i++) this.oval(frog, side * (.052 + .025 * (i % 2)), .182 - .014 * i, -.024 - i * .037, .016, .008, .023, 0x465f38);
    }

    for (const [index, p] of PADS.entries()) {
      const pad = new T.Group();
      this.group.add(pad);
      this.lilyPads.push(pad);
      pad.position.set(p.x, p.y - .018, p.z);
      const disk = new T.Mesh(new T.CylinderGeometry(.30, .285, .024, 30, 1, false, .36 + index, 5.93), this.material(0x608745));
      pad.add(disk);
      const petal = new T.MeshStandardMaterial({ color: PETALS[index], emissive: PETALS[index], emissiveIntensity: .06, roughness: .72 });
      this.petals.push(petal);
      for (let i = 0; i < 8; i++) {
        const a = i * Math.PI / 4;
        const m = new T.Mesh(this.sphere, petal);
        m.scale.set(.032, .035, .074);
        m.position.set(.16 + .041 * Math.sin(a), .052, .065 + .041 * Math.cos(a));
        m.rotation.set(-.3, a, 0, 'YXZ');
        pad.add(m);
      }
      this.oval(pad, .16, .078, .065, .035, .024, .035, 0xe1ad4d);
    }
    for (let i = 0; i < 11; i++) {
      const a = i * 2.4, r = .032 * Math.sqrt(i);
      this.oval(this.grain, Math.cos(a) * r, .024, Math.sin(a) * r, .017, .026, .014, i % 2 ? 0xffcb69 : 0xcd9945).rotation.z = a;
    }
    // Batch identical static parts (petals, feathers, toes) inside each animated group.
    for (const part of [bird, head, ...this.wings, frog, ...this.lilyPads, this.grain]) {
      const sets = new Map<T.Material, T.Mesh[]>();
      for (const mesh of part.children) {
        if (!(mesh instanceof T.Mesh) || mesh === this.throat || mesh.geometry !== this.sphere) continue;
        const matches = sets.get(mesh.material) ?? [];
        matches.push(mesh);
        sets.set(mesh.material, matches);
      }
      for (const [material, meshes] of sets) {
        if (meshes.length < 2) continue;
        const batch = new T.InstancedMesh(this.sphere, material, meshes.length);
        batch.castShadow = meshes[0].castShadow;
        meshes.forEach((mesh, i) => {
          mesh.updateMatrix();
          batch.setMatrixAt(i, mesh.matrix);
          mesh.removeFromParent();
        });
        part.add(batch);
      }
    }
  }

  private material(color: number): T.MeshStandardMaterial {
    let material = this.materials.get(color);
    if (!material) { material = new T.MeshStandardMaterial({ color, roughness: .83 }); this.materials.set(color, material); }
    return material;
  }

  private oval(parent: T.Group, x: number, y: number, z: number, w: number, h: number, d: number, color: number): T.Mesh {
    const mesh = new T.Mesh(this.sphere, this.material(color));
    mesh.scale.set(w, h, d); mesh.position.set(x, y, z);
    mesh.castShadow = true; parent.add(mesh);
    return mesh;
  }

  update(w: Wildlife, t: number, reduced: boolean): void {
    const b = w.robin, f = w.frog, motion = reduced ? .35 : 1;
    this.bird.position.set(b.position.x, b.position.y, b.position.z);
    this.bird.rotation.y = b.heading;
    this.head.rotation.x = w.robinMode === 'pecking' ? .45 + .45 * Math.sin(t * 14) : .08 * Math.sin(t * 1.9);
    this.head.rotation.z = .14 * Math.sin(t * 2.5) * motion;
    this.wings.forEach((wing, i) => { wing.rotation.z = (i ? 1 : -1) * (b.trip ? 1.2 + .6 * Math.sin(t * 34) * motion : 0); });
    this.frog.position.set(f.position.x, f.position.y, f.position.z);
    this.frog.rotation.y = f.heading;
    this.frog.rotation.x = f.trip ? -.35 * Math.sin(2 * Math.PI * f.trip.elapsed / f.trip.duration) * motion : 0;
    this.throat.scale.y = .055 + .016 * (.5 + .5 * Math.sin(t * 5)) * motion;
    this.grain.visible = !!w.seeds;
    if (w.seeds) this.grain.position.set(w.seeds.x, w.seeds.y, w.seeds.z);
    this.petals.forEach((m, i) => {
      m.emissiveIntensity = w.flash === i ? .95 : .06;
      this.lilyPads[i].position.y = PADS[i].y - .018 + .006 * Math.sin(t * 1.7 + i) * motion;
    });
  }

  dispose(): void {
    this.group.removeFromParent();
    const geometries = new Set<T.BufferGeometry>();
    this.group.traverse(o => { if (o instanceof T.Mesh) geometries.add(o.geometry); if (o instanceof T.InstancedMesh) o.dispose(); });
    for (const g of geometries) g.dispose();
    for (const m of [...this.materials.values(), ...this.petals]) m.dispose();
  }
}
