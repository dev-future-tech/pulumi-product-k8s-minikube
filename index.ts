import * as k8s from "@pulumi/kubernetes";
import * as kx from "@pulumi/kubernetesx";
import * as postgresql from "@pulumi/postgresql";
import * as pulumi from "@pulumi/pulumi";
import * as rabbitmq from "@pulumi/rabbitmq";

const config = new pulumi.Config();

const myVhost = new rabbitmq.VHost("my_vhost", {
    name: "product-vhost"
});

const productExchange = new rabbitmq.Exchange("productExchange", {
    settings: {
        autoDelete: false,
        durable: true,
        type: "topic",
    },
    name: "product-exchange",
    vhost: myVhost.name
});

const testPermissions = new rabbitmq.Permissions("test", {
    permissions: {
        configure: ".*",
        read: ".*",
        write: ".*",
    },
    user: "product-api",
    vhost: myVhost.name,
});

const requestQueue = new rabbitmq.Queue("product.requests", {
    settings: {
        autoDelete: false,
        durable: true
    },
    name: "product-requests",
    vhost: myVhost.name
});

const approvalsQueue = new rabbitmq.Queue("product.approvals", {
    settings: {
        autoDelete: false,
        durable: true
    },
    name: "product-approvals",
    vhost: myVhost.name
});

const productRequestsBinding = new rabbitmq.Binding("productRequestsBinding", {
    destination: requestQueue.name,
    destinationType: "queue",
    routingKey: "product.requests.#",
    source: productExchange.name,
    vhost: myVhost.name
});

const productApprovalsBinding = new rabbitmq.Binding("productApprovalsBinding", {
    destination: approvalsQueue.name,
    destinationType: "queue",
    routingKey: "product.approvals.#",
    source: productExchange.name,
    vhost: myVhost.name
});


const myDb = new postgresql.Database("product_database", {
    name: "product_database"
});

const user = new postgresql.Role("product_admin_user", {
    createDatabase: true,
    login: true,
    name: config.require("db_user_name"),
    password: config.requireSecret("db_user_password"),

});

const readonlyTables = new postgresql.Grant("product_tables", {
    database: myDb.name,
    objectType: "database",
    privileges: ["ALL"],
    role: user.name,
    schema: "public",
});

// Create the Namespace

const productNamespace = new k8s.core.v1.Namespace("product-ns", {
    metadata: {
        name: "product-ns-dev",
        labels: {
            "istio-injection": "enabled"
        }
    }
});

const productSecretMap = new k8s.core.v1.Secret("product-api-secrets", {
    metadata: {
        namespace: productNamespace.metadata.name
    },
    stringData: {
        database_password: config.requireSecret("db_user_password").apply(val => val)
    }
});

const productConfigMap = new k8s.core.v1.ConfigMap("product-api-config", {
    metadata: {
        namespace: productNamespace.metadata.name
    },
    data: {
        "database_username" : user.name,
        "database_url" : config.require("db_url") || "url-value",
        "rabbitmq_host" : config.require("rabbitmq_host") || "localhost-nonsense"
    }
});

const appLabels = { app: "product-api" };
const serviceAccountLabels = { account: "product-api" }

const productApiServiceAccount = new k8s.core.v1.ServiceAccount("product-api-sa", {
    metadata: {
        name: "product-api-sa",
        labels: serviceAccountLabels,
        namespace: productNamespace.metadata.name
    }
});

const deployment = new k8s.apps.v1.Deployment("product-api", {
    metadata: {
        namespace: productNamespace.metadata.name
    },
    spec: {
        selector: {
            matchLabels: appLabels
        },
        replicas: 1,
        template: {
            metadata: {
                labels: appLabels,
                name: "product-api"
            },
            spec: {
                serviceAccountName: productApiServiceAccount.metadata.name,
                containers: [
                    {
                        name: "product-sidecar",
                        image: "anthonyikeda/product-sidecar:0.0.2",
                        resources: {
                            limits: {
                                cpu: "500m",
                                memory: "256Mi"
                            },
                            requests: {
                                cpu: "500m",
                                memory: "256Mi"
                            }
                        },
                        ports: [
                            { containerPort: 7080, name: "sc-web" },
                            { containerPort: 7081, name: "sc-actuator" }
                        ],
                        imagePullPolicy: "IfNotPresent",
                        readinessProbe: {
                            httpGet: {
                                port: 7081,
                                path: "/actuator/health/readiness"
                            },
                            initialDelaySeconds: 30,
                            failureThreshold: 10,
                            periodSeconds: 3
                        },
                        livenessProbe: {
                            httpGet: {
                                port: 7081,
                                path: "/actuator/health/liveness"
                            },
                            initialDelaySeconds: 30,
                            failureThreshold: 10,
                            periodSeconds: 3
                        }
,                   },
                    {
                        name: "product-api",
                        image: "anthonyikeda/product-api:0.0.11",
                        resources: {
                            limits: {
                                cpu: "1000m",
                                memory: "512Mi"
                            },
                            requests: {
                                cpu: "1000m",
                                memory: "512Mi"
                            }
                        },
                        ports: [
                            { containerPort: 8090, name: "api-web" },
                            { containerPort: 8091, name: "api-actuator" }
                        ],
                        imagePullPolicy: "IfNotPresent",
                        readinessProbe: {
                            httpGet: {
                                port: 8091,
                                path: "/actuator/health/readiness"
                            },
                            initialDelaySeconds: 30,
                            failureThreshold: 10,
                            periodSeconds: 3
                        },
                        livenessProbe: {
                            httpGet: {
                                port: 8091,
                                path: "/actuator/health/liveness"
                            },
                            initialDelaySeconds: 30,
                            failureThreshold: 10,
                            periodSeconds: 3
                        },
                        env: [
                            { name: "SPRING_PROFILES_ACTIVE", value: "default" },
                            {
                                name: "SPRING_DATASOURCE_USERNAME",
                                valueFrom: {
                                    configMapKeyRef: {
                                        name: productConfigMap.metadata.name,
                                        key: "database_username"
                                    }
                                }
                            },
                            {
                                name: "SPRING_DATASOURCE_PASSWORD",
                                valueFrom: {
                                    secretKeyRef: {
                                        name: productSecretMap.metadata.name,
                                        key: "database_password"
                                    }
                                }
                            },
                            {
                                name: "SPRING_DATASOURCE_URL",
                                valueFrom: {
                                    configMapKeyRef: {
                                        name: productConfigMap.metadata.name,
                                        key: "database_url"
                                    }
                                }
                            },
                            {
                                name: "SPRING_RABBITMQ_HOST",
                                valueFrom: {
                                    configMapKeyRef: {
                                        name: productConfigMap.metadata.name,
                                        key: "rabbitmq_host"
                                    }
                                }
                            },
                            {
                                name: "SPRING_RABBITMQ_VIRTUAL_HOST",
                                value: "product-vhost"
                            },
                            {
                                name: "PRODUCT_POD_NAME",
                                valueFrom: {
                                    fieldRef: {
                                        fieldPath: "metadata.name"
                                    }
                                }
                            },
                            {
                                name: "LOGGING_LEVEL_ORG_FLOWER_PRODUCTAPI",
                                value: "debug"
                            },
                            {
                                name: "JAVA_OPTS",
                                value: "-Xms256m -Xmx512m -XX:MaxRAM=1G"
                            }
                        ]
                    }
                ]
            }
        }
    }
});

const service = new k8s.core.v1.Service("product-api-svc", {
    metadata: {
        namespace: productNamespace.metadata.name
    },
    spec: {
        type: "NodePort",
        ports: [
            {
                port: 80,
                protocol: "TCP",
                nodePort: 30001,
                targetPort: 8090,
            }
        ],
        selector: {
            app: "product-api",
        },
    }
});


const gateway = new k8s.apiextensions.CustomResource("istioGateway", {
    kind: "Gateway",
    apiVersion: "networking.istio.io/v1alpha3",
    metadata: {
        name: "product-api-gateway",
        namespace: productNamespace.metadata.name,
    },
    spec: {
        selector: {
            istio: "ingressgateway"
        },
        servers: [
            {
                port: {
                    number: 80,
                    name: "http",
                    protocol: "HTTP"
                },
                hosts: [ "*" ]
            }
        ]
    }
});

const virtualService = new k8s.apiextensions.CustomResource("istoVirtualService", {
    kind: "VirtualService",
    apiVersion: "networking.istio.io/v1alpha3",
    metadata: {
        name: "productinfo",
        namespace: productNamespace.metadata.name,
    },
    spec: {
        hosts: [ "*" ],
        gateways: ["product-api-gateway"],
        http: [
            {
                match: [
                    { uri: { exact: "/product/v1" }}
                ],
                route: [
                    {
                        destination: {
                            host: service.metadata.name,
                            port: {
                                number: 80
                            }
                        }
                    }
                ]
            }
        ]
    }
});
