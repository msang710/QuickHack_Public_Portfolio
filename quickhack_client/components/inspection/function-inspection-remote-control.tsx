"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { ExternalLink, Loader2, RefreshCcw, X } from "lucide-react";
import { Button } from "@/quickhack_client/components/ui/button";
import {
  FUNCTION_ACTION_GROUPS,
  MANUAL_URL,
} from "@/quickhack_shared/inspection/inspection-schema";

export type FunctionAction =
  (typeof FUNCTION_ACTION_GROUPS)[number]["actions"][number];

function prepareFunctionRemoteWindow(remoteWindow: Window) {
  remoteWindow.document.open();
  remoteWindow.document.write(`<!doctype html>
<html lang="ko">
  <head>
    <title>QuickHack 기능 검수 제어</title>
  </head>
  <body>
    <div id="quickhack-function-remote-root"></div>
  </body>
</html>`);
  remoteWindow.document.close();

  for (const node of Array.from(
    document.head.querySelectorAll('link[rel="stylesheet"], style')
  )) {
    remoteWindow.document.head.appendChild(node.cloneNode(true));
  }

  remoteWindow.document.body.className =
    "min-h-screen bg-background text-foreground antialiased";
}

// QuickHack object: 기능 검수 제어 리모컨을 별도 브라우저 창으로 열고 닫는 창 상태 훅입니다.
export function useFunctionRemoteWindow({
  onPopupBlocked,
}: {
  onPopupBlocked: () => void;
}) {
  const [isFunctionRemoteOpen, setIsFunctionRemoteOpen] =
    React.useState(false);
  const [functionRemoteWindow, setFunctionRemoteWindow] =
    React.useState<Window | null>(null);
  const functionRemoteWindowRef = React.useRef<Window | null>(null);

  React.useEffect(() => {
    const remoteWindow = functionRemoteWindow;

    if (!remoteWindow || remoteWindow.closed) {
      return;
    }

    function handleRemoteClose() {
      functionRemoteWindowRef.current = null;
      setFunctionRemoteWindow(null);
      setIsFunctionRemoteOpen(false);
    }

    remoteWindow.addEventListener("beforeunload", handleRemoteClose);

    const intervalId = window.setInterval(() => {
      if (remoteWindow.closed) {
        handleRemoteClose();
      }
    }, 500);

    return () => {
      window.clearInterval(intervalId);
      remoteWindow.removeEventListener("beforeunload", handleRemoteClose);
    };
  }, [functionRemoteWindow]);

  React.useEffect(() => {
    return () => {
      const remoteWindow = functionRemoteWindowRef.current;

      if (remoteWindow && !remoteWindow.closed) {
        remoteWindow.close();
      }
    };
  }, []);

  const closeFunctionRemoteWindow = React.useCallback(() => {
    const remoteWindow = functionRemoteWindowRef.current;

    functionRemoteWindowRef.current = null;
    setFunctionRemoteWindow(null);
    setIsFunctionRemoteOpen(false);

    if (remoteWindow && !remoteWindow.closed) {
      remoteWindow.close();
    }
  }, []);

  const openFunctionRemoteWindow = React.useCallback(() => {
    const existingWindow = functionRemoteWindowRef.current;

    if (existingWindow && !existingWindow.closed) {
      existingWindow.focus();
      setFunctionRemoteWindow(existingWindow);
      setIsFunctionRemoteOpen(true);
      return;
    }

    const remoteWindow = window.open(
      "",
      "quickhack-function-remote",
      "popup=yes,width=380,height=900,menubar=no,toolbar=no,location=no,status=no,resizable=yes,scrollbars=yes"
    );

    if (!remoteWindow) {
      onPopupBlocked();
      return;
    }

    prepareFunctionRemoteWindow(remoteWindow);
    functionRemoteWindowRef.current = remoteWindow;
    setFunctionRemoteWindow(remoteWindow);
    setIsFunctionRemoteOpen(true);
    remoteWindow.focus();
  }, [onPopupBlocked]);

  const functionRemoteRoot =
    isFunctionRemoteOpen && functionRemoteWindow && !functionRemoteWindow.closed
      ? functionRemoteWindow.document.getElementById(
          "quickhack-function-remote-root"
        )
      : null;

  return {
    isFunctionRemoteOpen,
    functionRemoteRoot,
    openFunctionRemoteWindow,
    closeFunctionRemoteWindow,
  };
}

type FunctionInspectionRemotePortalProps = {
  root: HTMLElement | null;
  connectedDeviceCount: number;
  readyDeviceCount: number;
  ignoredAdbDeviceCount: number;
  allDevices: boolean;
  isLoadingDevices: boolean;
  isRunningAdbAction: boolean;
  onAllDevicesChange: (checked: boolean) => void;
  onFunctionAction: (action: FunctionAction) => void;
  onClose: () => void;
};

export function FunctionInspectionRemotePortal({
  root,
  connectedDeviceCount,
  readyDeviceCount,
  ignoredAdbDeviceCount,
  allDevices,
  isLoadingDevices,
  isRunningAdbAction,
  onAllDevicesChange,
  onFunctionAction,
  onClose,
}: FunctionInspectionRemotePortalProps) {
  if (!root) {
    return null;
  }

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="기능 검수 제어"
      className="min-h-screen bg-popover text-popover-foreground"
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          onClose();
        }
      }}
    >
      <div className="flex items-start justify-between gap-3 border-b bg-background px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold">기능 검수 제어</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            작업 대상 {connectedDeviceCount}대 / 작업 가능 {readyDeviceCount}대
            {ignoredAdbDeviceCount > 0
              ? ` / 가상 포트 제외 ${ignoredAdbDeviceCount}개`
              : ""}
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="기능 검수 제어 닫기"
          onClick={onClose}
        >
          <X className="size-4" />
        </Button>
      </div>

      <div className="grid gap-4 overflow-auto p-4">
        {FUNCTION_ACTION_GROUPS.map((group) => (
          <div key={group.title} className="grid gap-2">
            <div className="border-b pb-1 text-xs font-semibold">
              {group.title}
            </div>
            {group.actions.map((action) => (
              <Button
                key={action.id}
                type="button"
                variant="outline"
                onClick={() => onFunctionAction(action)}
                disabled={isLoadingDevices || isRunningAdbAction}
              >
                {action.id === "refresh" && isLoadingDevices ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : action.id === "refresh" ? (
                  <RefreshCcw className="size-4" />
                ) : null}
                {action.label}
              </Button>
            ))}
          </div>
        ))}

        <label className="inline-flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="size-4 rounded border-input"
            checked={allDevices}
            onChange={(event) => onAllDevicesChange(event.target.checked)}
          />
          모든 기기에 적용
        </label>

        <Button
          type="button"
          variant="outline"
          onClick={() => window.open(MANUAL_URL, "_blank", "noopener,noreferrer")}
        >
          <ExternalLink className="size-4" />
          기기 연결 매뉴얼 보기
        </Button>

        <div className="rounded-md border bg-background px-3 py-2 text-xs leading-5 text-muted-foreground">
          USB 디버깅 연결 방법 | 휴대폰 설정 → 휴대전화 정보 → 소프트웨어 정보 →
          빌드번호 7번 터치 → 개발자 옵션 → USB 디버깅 ON → USB 연결 후 항상
          허용
        </div>
      </div>
    </div>,
    root
  );
}
