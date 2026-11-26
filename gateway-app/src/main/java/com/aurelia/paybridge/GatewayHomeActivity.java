package com.aurelia.paybridge;

import android.app.Activity;
import android.os.Bundle;
import android.view.Gravity;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

/** User-controlled pairing approval for the optional Aurelia PMS companion connection. */
public final class GatewayHomeActivity extends Activity {
  private GatewayApprovalStore approvals;
  private TextView status;

  @Override protected void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);
    approvals = new GatewayApprovalStore(this);

    LinearLayout root = new LinearLayout(this);
    root.setOrientation(LinearLayout.VERTICAL);
    root.setPadding(36, 48, 36, 36);
    root.setGravity(Gravity.CENTER_VERTICAL);

    TextView title = new TextView(this);
    title.setText("Aurelia Gateway");
    title.setTextSize(28);
    title.setGravity(Gravity.CENTER);
    root.addView(title);

    TextView description = new TextView(this);
    description.setText("Aurelia Gateway connects to Aurelia PMS only after you approve the connection. This approval enables the authenticated app connection only; payment processing and provider activation are not enabled by this prototype.");
    description.setTextSize(16);
    description.setPadding(0, 24, 0, 24);
    root.addView(description);

    status = new TextView(this);
    status.setTextSize(15);
    root.addView(status);

    Button approve = new Button(this);
    approve.setText("Approve Aurelia PMS connection");
    approve.setOnClickListener(v -> {
      approvals.setPmsConnectionApproved(true);
      renderStatus();
    });
    root.addView(approve);

    Button revoke = new Button(this);
    revoke.setText("Revoke connection approval");
    revoke.setOnClickListener(v -> {
      approvals.setPmsConnectionApproved(false);
      renderStatus();
    });
    root.addView(revoke);

    setContentView(root);
    renderStatus();
  }

  @Override protected void onResume() {
    super.onResume();
    renderStatus();
  }

  private void renderStatus() {
    if (status == null || approvals == null) return;
    status.setText(approvals.isPmsConnectionApproved()
        ? "Connection approval: granted. You can now connect from Aurelia PMS."
        : "Connection approval: not granted. Aurelia PMS cannot connect yet.");
  }
}
