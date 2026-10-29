FROM grafana/alloy:v1.21.0
COPY ops/observability/config.alloy /etc/alloy/config.alloy
# 固定版私网采集器；禁止添加公网 Railway domain。
EXPOSE 4318
ENTRYPOINT ["/bin/alloy"]
CMD ["run", "--server.http.listen-addr=[::]:12345", "--storage.path=/tmp/alloy", "/etc/alloy/config.alloy"]
