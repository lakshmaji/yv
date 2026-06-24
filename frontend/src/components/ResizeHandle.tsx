import { onMount, onCleanup } from 'solid-js';

interface ResizeHandleProps {
  id: string;
  getWidth: () => number;
  setWidth: (w: number) => void;
  onResize: () => void;
}

export default function ResizeHandle(props: ResizeHandleProps) {
  let handleRef!: HTMLDivElement;

  onMount(() => {
    const onMouseDown = (e: MouseEvent): void => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = props.getWidth();
      handleRef.classList.add('dragging');

      const onMove = (ev: MouseEvent): void => {
        props.setWidth(Math.max(80, startW + (ev.clientX - startX)));
        if (props.onResize) props.onResize();
      };

      const onUp = (): void => {
        handleRef.classList.remove('dragging');
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    };

    handleRef.addEventListener('mousedown', onMouseDown);

    onCleanup(() => {
      handleRef.removeEventListener('mousedown', onMouseDown);
    });
  });

  return <div class="resize-handle" id={props.id} ref={handleRef} />;
}
