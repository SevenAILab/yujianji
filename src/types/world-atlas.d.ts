declare module "world-atlas/countries-110m.json" {
  const value: {
    type: "Topology";
    objects: {
      countries: {
        type: string;
        geometries: Array<{
          type: string;
          id?: string | number;
          properties?: Record<string, unknown>;
          arcs?: unknown;
        }>;
      };
    };
    arcs: unknown[];
  };

  export default value;
}
