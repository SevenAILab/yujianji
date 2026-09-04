"use client";

import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
}

export class MapErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("world_map_error", {
      name: error.name,
      componentStack: info.componentStack,
    });
  }

  render() {
    if (this.state.hasError) {
      return (
        <section className="map-card surface map-fallback" role="status">
          <div>
            <strong>地图暂时无法显示</strong>
            <span>你的藏品和第一次仍然保存在下面。</span>
          </div>
        </section>
      );
    }

    return this.props.children;
  }
}
