import React, { memo } from "react";
import type { NotificationItem } from "../../types/map";

interface NotificationDropdownProps {
  notifications: NotificationItem[];
  isOpen: boolean;
  onClose: () => void;
  onMarkAllAsRead: () => void;
  onNotificationClick: (noti: NotificationItem) => void;
  formatNotiTime: (dateString: string) => string;
}

const NotificationDropdown = memo(({
  notifications,
  isOpen,
  onClose,
  onMarkAllAsRead,
  onNotificationClick,
  formatNotiTime,
}: NotificationDropdownProps) => {
  if (!isOpen) return null;

  return (
    <>
      <div
        style={{
          position: "fixed",
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          zIndex: 6999,
        }}
        onClick={onClose}
      />
      <div
        style={{
          position: "absolute",
          top: "30px",
          right: "-10px",
          width: "280px",
          backgroundColor: "#1a1a1a",
          border: "1px solid #333",
          borderRadius: "8px",
          boxShadow: "0 4px 12px rgba(0,0,0,0.5)",
          zIndex: 7000,
          display: "flex",
          flexDirection: "column",
          maxHeight: "350px",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            padding: "12px 15px",
            borderBottom: "1px solid #333",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            backgroundColor: "#252525",
          }}
        >
          <span
            style={{
              fontWeight: "bold",
              fontSize: "13px",
              color: "#F2A900",
            }}
          >
            알림 내역
          </span>
          {notifications.some((n) => !n.is_read) && (
            <button
              onClick={onMarkAllAsRead}
              style={{
                background: "none",
                border: "none",
                color: "#aaa",
                fontSize: "11px",
                cursor: "pointer",
                fontWeight: "bold",
              }}
            >
              모두 읽음
            </button>
          )}
        </div>

        <div
          style={{
            overflowY: "auto",
            flex: 1,
            backgroundColor: "#1a1a1a",
          }}
        >
          {notifications.length === 0 ? (
            <div
              style={{
                padding: "30px 20px",
                textAlign: "center",
                color: "#666",
                fontSize: "12px",
              }}
            >
              새로운 알림이 없습니다.
            </div>
          ) : (
            notifications.map((noti) => (
              <div
                key={noti.id}
                onClick={() => onNotificationClick(noti)}
                style={{
                  padding: "12px 15px",
                  borderBottom: "1px solid #222",
                  cursor: "pointer",
                  backgroundColor: noti.is_read
                    ? "transparent"
                    : "rgba(242, 169, 0, 0.08)",
                  transition: "background-color 0.2s",
                  display: "flex",
                  flexDirection: "column",
                  gap: "6px",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "flex-start",
                    gap: "8px",
                  }}
                >
                  <div
                    style={{
                      fontSize: "13px",
                      color: noti.is_read ? "#777" : "#fff",
                      lineHeight: "1.4",
                      flex: 1,
                      wordBreak: "keep-all",
                    }}
                  >
                    <strong
                      style={{
                        color: noti.is_read ? "#888" : "#F2A900",
                      }}
                    >
                      {noti.sender_name}
                    </strong>
                    님이{" "}
                    {noti.type === "support_reply"
                      ? " 고객센터 문의에 답변했습니다."
                      : noti.type === "reply"
                        ? " 내 댓글에 답글을 남겼습니다."
                        : " 내 글에 댓글을 남겼습니다."}
                  </div>
                  {noti.preview_text && (
                    <div
                      style={{
                        maxWidth: "90px",
                        fontSize: "11px",
                        color: noti.is_read ? "#555" : "#aaa",
                        backgroundColor: noti.is_read
                          ? "transparent"
                          : "rgba(255,255,255,0.05)",
                        padding: "4px 6px",
                        borderRadius: "4px",
                        border: "1px solid #333",
                        flexShrink: 0,
                        lineHeight: "1.4",
                        display: "-webkit-box",
                        WebkitBoxOrient: "vertical",
                        WebkitLineClamp: 2,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "normal",
                      }}
                    >
                      {noti.preview_text}
                    </div>
                  )}
                </div>
                <div style={{ fontSize: "11px", color: "#555" }}>
                  {formatNotiTime(noti.created_at)}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </>
  );
});

NotificationDropdown.displayName = "NotificationDropdown";
export default NotificationDropdown;
