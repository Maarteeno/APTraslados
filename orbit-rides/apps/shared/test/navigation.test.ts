import { describe, it, expect } from 'vitest';
import {
  bearingBetween, computeProgress, cumulativeDistances, describeStep,
  formatArrival, formatDistance, metersBetween, projectOntoPath, remainingPath,
  type NavPoint, type RouteStep,
} from '../src/navigation';

/**
 * Un tramo recto hacia el este sobre Montevideo.
 *
 * Se eligió recto y horizontal a propósito: las distancias esperadas se pueden
 * calcular a mano, así que si un test falla se sabe si el error está en el
 * código o en la expectativa.
 */
const LAT = -34.9;
const path: NavPoint[] = [
  { lat: LAT, lng: -56.20 },
  { lat: LAT, lng: -56.19 },
  { lat: LAT, lng: -56.18 },
  { lat: LAT, lng: -56.17 },
];

/** Un grado de longitud en esta latitud, en metros. */
const M_PER_DEG_LNG = 6_371_000 * (Math.PI / 180) * Math.cos(LAT * (Math.PI / 180));

function step(over: Partial<RouteStep> = {}): RouteStep {
  return {
    distanceMeters: 100,
    durationSeconds: 20,
    name: 'Avenida Brasil',
    type: 'turn',
    modifier: 'right',
    at: { lat: LAT, lng: -56.19 },
    exit: null,
    ...over,
  };
}

describe('distancias y rumbos', () => {
  it('mide un grado de longitud en Montevideo con error menor al 1 %', () => {
    const d = metersBetween({ lat: LAT, lng: -56.20 }, { lat: LAT, lng: -56.19 });
    expect(d).toBeCloseTo(M_PER_DEG_LNG / 100, -1);
  });

  it('la longitud se acorta con la latitud: no confundir grados con metros', () => {
    // El mismo delta de longitud mide menos lejos del ecuador. Si el código
    // ignorara el coseno, estas dos distancias saldrían iguales y todo el
    // cálculo de progreso quedaría deformado un 18 % en Montevideo.
    const enMontevideo = metersBetween({ lat: -34.9, lng: 0 }, { lat: -34.9, lng: 0.01 });
    const enElEcuador = metersBetween({ lat: 0, lng: 0 }, { lat: 0, lng: 0.01 });
    expect(enMontevideo).toBeLessThan(enElEcuador);
    expect(enMontevideo / enElEcuador).toBeCloseTo(Math.cos(34.9 * Math.PI / 180), 2);
  });

  it('el rumbo hacia el este es 90° y hacia el norte 0°', () => {
    expect(bearingBetween({ lat: LAT, lng: -56.2 }, { lat: LAT, lng: -56.1 })).toBeCloseTo(90, 0);
    expect(bearingBetween({ lat: -34.9, lng: -56.2 }, { lat: -34.8, lng: -56.2 })).toBeCloseTo(0, 0);
  });
});

describe('proyección sobre el trazado', () => {
  it('un punto sobre la línea proyecta con desvío cero', () => {
    const p = projectOntoPath(path, { lat: LAT, lng: -56.195 });
    expect(p).not.toBeNull();
    expect(p?.offRouteMeters).toBeLessThan(1);
    expect(p?.segmentIndex).toBe(0);
  });

  it('mide lo recorrido a lo largo de la línea, no en línea recta al origen', () => {
    const p = projectOntoPath(path, { lat: LAT, lng: -56.185 });
    // Va por la mitad del tercer punto: 1.5 grados de centésima.
    expect(p?.traveledMeters).toBeCloseTo(M_PER_DEG_LNG * 0.015, -1);
  });

  it('un punto al costado reporta la separación, y esa es la señal de desvío', () => {
    const p = projectOntoPath(path, { lat: LAT + 0.001, lng: -56.195 });
    expect(p?.offRouteMeters).toBeGreaterThan(90);
    expect(p?.offRouteMeters).toBeLessThan(130);
  });

  it('satura en los extremos: antes del inicio no da distancia negativa', () => {
    const p = projectOntoPath(path, { lat: LAT, lng: -56.25 });
    expect(p?.traveledMeters).toBe(0);
    expect(p?.offRouteMeters).toBeGreaterThan(0);
  });

  it('sobrevive a puntos duplicados, que OSRM emite en las intersecciones', () => {
    const conDuplicados: NavPoint[] = [
      { lat: LAT, lng: -56.20 },
      { lat: LAT, lng: -56.20 },
      { lat: LAT, lng: -56.19 },
    ];
    const p = projectOntoPath(conDuplicados, { lat: LAT, lng: -56.195 });
    expect(p).not.toBeNull();
    expect(Number.isFinite(p?.traveledMeters)).toBe(true);
  });

  it('no explota con un trazado vacío o de un solo punto', () => {
    expect(projectOntoPath([], { lat: LAT, lng: -56.2 })).toBeNull();
    const uno = projectOntoPath([{ lat: LAT, lng: -56.2 }], { lat: LAT, lng: -56.19 });
    expect(uno?.traveledMeters).toBe(0);
  });
});

describe('distancias acumuladas', () => {
  it('arranca en cero y crece', () => {
    const c = cumulativeDistances(path);
    expect(c[0]).toBe(0);
    expect(c).toHaveLength(path.length);
    expect(c[3]).toBeGreaterThan(c[2] as number);
  });
});

describe('progreso y próxima maniobra', () => {
  const steps = [
    step({ type: 'depart', at: { lat: LAT, lng: -56.20 }, modifier: null }),
    step({ type: 'turn', modifier: 'right', at: { lat: LAT, lng: -56.19 }, name: 'Bulevar Artigas' }),
    step({ type: 'turn', modifier: 'left', at: { lat: LAT, lng: -56.18 }, name: 'Avenida Italia' }),
    step({ type: 'arrive', at: { lat: LAT, lng: -56.17 }, modifier: null, name: '' }),
  ];

  it('al arrancar apunta a la primera maniobra real, no a la de salida', () => {
    const progress = computeProgress(path, steps, { lat: LAT, lng: -56.1995 });
    expect(progress?.step?.name).toBe('Bulevar Artigas');
    expect(progress?.distanceToManeuverMeters).toBeGreaterThan(0);
  });

  it('pasada una esquina, avanza a la siguiente', () => {
    // Un poco después del segundo punto: la maniobra de Bulevar Artigas ya quedó
    // atrás, aunque por pocos metros.
    const progress = computeProgress(path, steps, { lat: LAT, lng: -56.1895 });
    expect(progress?.step?.name).toBe('Avenida Italia');
  });

  it('la distancia a la maniobra se mide sobre el trazado y decrece al avanzar', () => {
    const lejos = computeProgress(path, steps, { lat: LAT, lng: -56.1980 });
    const cerca = computeProgress(path, steps, { lat: LAT, lng: -56.1905 });
    expect(cerca?.step?.name).toBe('Bulevar Artigas');
    expect(cerca!.distanceToManeuverMeters).toBeLessThan(lejos!.distanceToManeuverMeters);
  });

  it('lo que falta baja a medida que se avanza y nunca es negativo', () => {
    const inicio = computeProgress(path, steps, { lat: LAT, lng: -56.20 });
    const final = computeProgress(path, steps, { lat: LAT, lng: -56.17 });
    expect(final!.remainingMeters).toBeLessThan(inicio!.remainingMeters);
    expect(final!.remainingMeters).toBeGreaterThanOrEqual(0);
    // Pasarse del final tampoco puede dar negativo.
    const pasado = computeProgress(path, steps, { lat: LAT, lng: -56.16 });
    expect(pasado!.remainingMeters).toBeGreaterThanOrEqual(0);
  });

  it('un desvío se nota en offRouteMeters, que es la señal para recalcular', () => {
    const enRuta = computeProgress(path, steps, { lat: LAT, lng: -56.19 });
    const desviado = computeProgress(path, steps, { lat: LAT + 0.005, lng: -56.19 });
    expect(enRuta!.offRouteMeters).toBeLessThan(5);
    expect(desviado!.offRouteMeters).toBeGreaterThan(400);
  });

  it('sin maniobras devuelve progreso igual, para poder dibujar sin cartel', () => {
    const progress = computeProgress(path, [], { lat: LAT, lng: -56.19 });
    expect(progress).not.toBeNull();
    expect(progress?.step).toBeNull();
    expect(progress!.remainingMeters).toBeGreaterThan(0);
  });

  it('con trazado vacío devuelve null en vez de inventar', () => {
    expect(computeProgress([], steps, { lat: LAT, lng: -56.19 })).toBeNull();
  });
});

describe('tramo restante', () => {
  it('empieza en la posición proyectada y no en el vértice siguiente', () => {
    const rest = remainingPath(path, { lat: LAT, lng: -56.195 });
    expect(rest[0]?.lng).toBeCloseTo(-56.195, 4);
    expect(rest.length).toBeLessThan(path.length + 1);
  });

  it('cerca del final quedan pocos puntos', () => {
    const rest = remainingPath(path, { lat: LAT, lng: -56.171 });
    expect(rest.length).toBeLessThanOrEqual(2);
  });
});

describe('texto de las instrucciones', () => {
  it('traduce un giro con su calle', () => {
    const i = describeStep(step({ type: 'turn', modifier: 'left', name: 'Avenida Brasil' }));
    expect(i.action).toBe('Girá a la izquierda');
    expect(i.street).toBe('Avenida Brasil');
    expect(i.arrow).toBe('←');
  });

  it('la rotonda dice qué salida tomar', () => {
    const i = describeStep(step({ type: 'roundabout', exit: 2, modifier: null }));
    expect(i.action).toContain('salida 2');
    expect(i.arrow).toBe('↻');
  });

  it('la llegada y la salida tienen texto propio', () => {
    expect(describeStep(step({ type: 'arrive', modifier: null })).action).toBe('Llegaste');
    expect(describeStep(step({ type: 'depart', modifier: null })).action).toBe('Arrancá');
  });

  it('una maniobra desconocida NO muestra el identificador en inglés', () => {
    // Es el punto del default: a un conductor «fork slight left» no le dice
    // nada, y OSRM puede agregar tipos nuevos en cualquier versión.
    const i = describeStep(step({ type: 'algo que todavia no existe', modifier: 'slight right' }));
    expect(i.action).toBe('Seguí levemente a la derecha');
    expect(i.action).not.toContain('algo que todavia no existe');
  });

  it('sin maniobra da un texto usable en vez de romper', () => {
    expect(describeStep(null).action).toBe('Seguí por la ruta');
  });
});

describe('formatos', () => {
  it('redondea a decenas por debajo del kilómetro', () => {
    expect(formatDistance(247)).toBe('en 250 m');
    expect(formatDistance(612)).toBe('en 610 m');
  });

  it('pasa a kilómetros con coma decimal', () => {
    expect(formatDistance(1500)).toBe('en 1,5 km');
  });

  it('muy cerca dice "ahora": un número ahí no ayuda a nadie', () => {
    expect(formatDistance(8)).toBe('ahora');
  });

  it('la hora de llegada suma los segundos al reloj', () => {
    const now = new Date('2026-07-29T14:30:00');
    expect(formatArrival(15 * 60, now)).toBe('14:45');
    expect(formatArrival(90 * 60, now)).toBe('16:00');
  });
});
